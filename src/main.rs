use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    extract::ws::{WebSocket, WebSocketUpgrade},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::ServeDir;
use tower::ServiceBuilder;
use sqlx::{SqlitePool, Row};
use tokio::sync::broadcast;

#[derive(Deserialize)]
struct DeleteRequest {
    filename: String,
    password: Option<String>,
}

// 🆕 Define a clean structure to pass file and album details together
#[derive(Serialize)]
struct ImageItem {
    filename: String,
    album: String,
}

// 🛠️ CUSTOM DESERIALIZER: Matches the Assign Album API payload parameters
#[derive(Deserialize)]
struct AssignAlbumRequest {
    filename: String,
    album: String,
    password: Option<String>,
}

#[derive(Deserialize)]
struct ImageQuery {
    offset: usize,
    limit: usize,
    search: Option<String>,
    sort: Option<String>,
    min_size: Option<i64>,
    max_size: Option<i64>,
    album: Option<String>,
}

#[derive(Serialize)]
struct AlbumListResponse {
    albums: Vec<String>,
}

#[derive(Serialize)]
struct ImageList {
    images: Vec<ImageItem>,
    has_more: bool,
}

// Extra fields matching live stream sync pipelines
#[derive(Serialize, Clone)]
struct UploadResponse {
    filename: String,
    album: String,
}

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    images_dir: String,
    thumbnails_dir: String,
    tx: broadcast::Sender<UploadResponse>,
    master_password: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    let is_termux = std::path::Path::new("/data/data/com.termux/files/home").exists();

    let (images_dir, thumbnails_dir) = if is_termux {
        (
            "/data/data/com.termux/files/home/images".to_string(),
            "/data/data/com.termux/files/home/thumb".to_string()
        )
    } else {
        (
            std::env::var("IMAGES_DIR").unwrap_or_else(|_| "./images".to_string()),
            std::env::var("THUMBNAILS_DIR").unwrap_or_else(|_| "./thumb".to_string())
        )
    };

    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://gallery.db".to_string());

    let _ = fs::create_dir_all(&images_dir);
    let _ = fs::create_dir_all(&thumbnails_dir);

    let db_filename = db_url.replace("sqlite://", "");
    let db_pool = SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_filename)
            .create_if_missing(true)
    )
    .await
    .unwrap();

    let master_password = std::env::var("MASTER_PASSWORD").unwrap_or_else(|_| "@jo111".to_string());
    let (tx, _rx) = broadcast::channel(16);
    
    let index_html_content = include_str!("../static/index.html");
    let style_css_content = include_str!("../static/style.css");
    let app_js_content = include_str!("../static/app.js");

    let state = AppState {
        db: db_pool,
        images_dir,
        thumbnails_dir,
        tx,
        master_password,
    };

    let app = Router::new()
        .route("/", get(move || async move { Html(index_html_content) }))
        .route("/static/style.css", get(move || async move {
            ([(header::CONTENT_TYPE, "text/css")], style_css_content)
        }))
        .route("/static/app.js", get(move || async move {
            ([(header::CONTENT_TYPE, "application/javascript")], app_js_content)
        }))
        .route("/api/albums", get(get_albums_list))
        .route("/api/images", get(get_images_json))
        .route("/api/upload", post(upload_image))
        // Registering the custom assign album post routing endpoint
        .route("/api/images/assign_album", post(assign_album_to_existing_image))
        .route("/api/ws", get(ws_handler))
        .route("/thumb/:filename", get(get_thumbnail))
        .route("/api/delete", post(delete_image))
        .nest_service("/images", ServeDir::new(&state.images_dir))
        .with_state(state)
        .layer(ServiceBuilder::new().layer(DefaultBodyLimit::max(50 * 1024 * 1024)));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
     println!("Server running on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn upload_image(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut file_data = Vec::new();
    let mut filename = String::new();
    let mut password_provided = String::new();
    let mut album_tag: Option<String> = None;

    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        match name.as_str() {
            "password" => { password_provided = field.text().await.unwrap(); }
            "album" => {
                let text_val = field.text().await.unwrap().trim().to_string();
                if !text_val.is_empty() { album_tag = Some(text_val); }
            }
            "image" => {
                filename = field.file_name().unwrap().to_string();
                file_data = field.bytes().await.unwrap().to_vec();
            }
            _ => {}
        }
    }

    if password_provided != state.master_password {
        return (StatusCode::UNAUTHORIZED, "Incorrect master password").into_response();
    }

    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let unique_filename = format!("{}_{}", timestamp, filename);
    let save_path = PathBuf::from(&state.images_dir).join(&unique_filename);

    if fs::write(&save_path, &file_data).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to write file").into_response();
    }

    let file_size = file_data.len() as i64;
    let clean_album = album_tag.unwrap_or_default();

    let insert_res = sqlx::query(
        "INSERT INTO images (filename, created_at, file_size) VALUES (?, ?, ?);"
    )
    .bind(&unique_filename)
    .bind(timestamp as i64)
    .bind(file_size)
    .execute(&state.db)
    .await;

    if let Ok(result) = insert_res {
        let image_id = result.last_insert_rowid();
        if !clean_album.is_empty() {
            let _ = sqlx::query("INSERT OR IGNORE INTO albums (name) VALUES (?);").bind(&clean_album).execute(&state.db).await;
            if let Ok(row) = sqlx::query("SELECT id FROM albums WHERE name = ?;").bind(&clean_album).fetch_one(&state.db).await {
                let album_id: i64 = row.get(0);
                let _ = sqlx::query("INSERT OR IGNORE INTO image_albums (image_id, album_id) VALUES (?, ?);").bind(image_id).bind(album_id).execute(&state.db).await;
            }
        }
        
        let response_payload = UploadResponse { filename: unique_filename, album: clean_album };
        let _ = state.tx.send(response_payload.clone());
        return Json(response_payload).into_response();
    }




    (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
}

// 🛠️ CUSTOM HANDLER: Assigns albums to existing photos cleanly without modifying core vectors
async fn assign_album_to_existing_image(
    State(state): State<AppState>,
    Json(req): Json<AssignAlbumRequest>,
) -> impl IntoResponse {
    if req.password.as_deref() != Some(&state.master_password) {
        return (StatusCode::UNAUTHORIZED, "Incorrect master password").into_response();
    }

    let img_row = sqlx::query("SELECT id FROM images WHERE filename = ?;")
        .bind(&req.filename)
        .fetch_optional(&state.db)
        .await;

    if let Ok(Some(row)) = img_row {
        let image_id: i64 = row.get(0);
        let _ = sqlx::query("DELETE FROM image_albums WHERE image_id = ?;").bind(image_id).execute(&state.db).await;

        if !req.album.is_empty() {
            let _ = sqlx::query("INSERT OR IGNORE INTO albums (name) VALUES (?);").bind(&req.album).execute(&state.db).await;
            if let Ok(alb_row) = sqlx::query("SELECT id FROM albums WHERE name = ?;").bind(&req.album).fetch_one(&state.db).await {
                let album_id: i64 = alb_row.get(0);
                let _ = sqlx::query("INSERT OR IGNORE INTO image_albums (image_id, album_id) VALUES (?, ?);").bind(image_id).bind(album_id).execute(&state.db).await;
            }
        }

        // 🆕 BROADCAST THE UPDATE: Notify all open browsers about the new album alignment!
        let response_payload = UploadResponse { 
            filename: req.filename.clone(), 
            album: req.album.clone() 
        };
        let _ = state.tx.send(response_payload);

        return StatusCode::OK.into_response();
    }

    (StatusCode::NOT_FOUND, "Image metadata record missing").into_response()
}







async fn get_images_json(
    State(state): State<AppState>,
    pagination: Query<ImageQuery>,
) -> impl IntoResponse {
    let offset = pagination.offset as i64;
    let limit = pagination.limit as i64;

    // 1. SELECT both the filename and its matching album name dynamically
    let mut query_str = "
        SELECT i.filename, COALESCE(a.name, '') as album_name 
        FROM images i
        LEFT JOIN image_albums ia ON i.id = ia.image_id
        LEFT JOIN albums a ON ia.album_id = a.id
        WHERE 1=1
    ".to_string();

    // Append filters
    if let Some(ref alb) = pagination.album {
        if alb != "all" && !alb.is_empty() {
            query_str.push_str(" AND a.name = ?");
        } else if alb.is_empty() {
            query_str.push_str(" AND ia.album_id IS NULL");
        }
    }
    if pagination.search.is_some() { query_str.push_str(" AND i.filename LIKE ?"); }
    if pagination.min_size.is_some() { query_str.push_str(" AND i.file_size >= ?"); }
    if pagination.max_size.is_some() { query_str.push_str(" AND i.file_size <= ?"); }

    let sort_order = pagination.sort.as_deref().unwrap_or("recent");
    if sort_order == "oldest" { query_str.push_str(" ORDER BY i.created_at ASC, i.id ASC"); }
    else { query_str.push_str(" ORDER BY i.created_at DESC, i.id DESC"); }
    query_str.push_str(" LIMIT ? OFFSET ?;");

    // Bind arguments
    let mut db_query = sqlx::query(&query_str);
    if let Some(ref alb) = pagination.album {
        if alb != "all" && !alb.is_empty() { db_query = db_query.bind(alb); }
    }
    if let Some(ref s) = pagination.search { db_query = db_query.bind(format!("%{}%", s)); }
    if let Some(min) = pagination.min_size { db_query = db_query.bind(min); }
    if let Some(max) = pagination.max_size { db_query = db_query.bind(max); }
    db_query = db_query.bind(limit).bind(offset);

    let rows = db_query.fetch_all(&state.db).await.unwrap();
    
    // 🆕 Map rows into our new structural ImageItem format
    let images: Vec<ImageItem> = rows.iter().map(|r| {
        ImageItem {
            filename: r.get::<String, _>("filename"),
            album: r.get::<String, _>("album_name"),
        }
    }).collect();

    // 2. Count query for pagination tracking
    let mut count_str = "
        SELECT COUNT(*) 
        FROM images i
        LEFT JOIN image_albums ia ON i.id = ia.image_id
        LEFT JOIN albums a ON ia.album_id = a.id
        WHERE 1=1
    ".to_string();

    if let Some(ref alb) = pagination.album {
        if alb != "all" && !alb.is_empty() { count_str.push_str(" AND a.name = ?"); }
        else if alb.is_empty() { count_str.push_str(" AND ia.album_id IS NULL"); }
    }
    if pagination.search.is_some() { count_str.push_str(" AND i.filename LIKE ?"); }
    if pagination.min_size.is_some() { count_str.push_str(" AND i.file_size >= ?"); }
    if pagination.max_size.is_some() { count_str.push_str(" AND i.file_size <= ?"); }

    let mut count_query = sqlx::query(&count_str);
    if let Some(ref alb) = pagination.album {
        if alb != "all" && !alb.is_empty() { count_query = count_query.bind(alb); }
    }
    if let Some(ref s) = pagination.search { count_query = count_query.bind(format!("%{}%", s)); }
    if let Some(min) = pagination.min_size { count_query = count_query.bind(min); }
    if let Some(max) = pagination.max_size { count_query = count_query.bind(max); }
    
    let total_count: i64 = count_query.fetch_one(&state.db).await.unwrap().get(0);
    let has_more = (offset + images.len() as i64) < total_count;

    Json(ImageList { images, has_more }).into_response()
}






async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut rx = state.tx.subscribe();
    while let Ok(upload_info) = rx.recv().await {
        let json_msg = serde_json::to_string(&upload_info).unwrap_or_default();
        if socket.send(axum::extract::ws::Message::Text(json_msg.into())).await.is_err() { break; }
    }
}


// ⚙️ UPDATED HANDLER: Calls our auto-orienting helper function safely
async fn get_thumbnail(State(state): State<AppState>, Path(filename): Path<String>) -> impl IntoResponse {
    let thumb_path = PathBuf::from(&state.thumbnails_dir).join(&filename);
    if thumb_path.exists() {
        if let Ok(bytes) = fs::read(&thumb_path) { 
            return ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(); 
        }
    }

    let base_stem = filename.rfind('.').map(|p| &filename[..p]).unwrap_or(&filename);
    let search_pattern = format!("{}.%", base_stem);
    let fallback_row = sqlx::query("SELECT filename FROM images WHERE filename LIKE ? LIMIT 1")
        .bind(&search_pattern)
        .fetch_optional(&state.db)
        .await;

    let original_filename = match fallback_row {
        Ok(Some(row)) => row.get::<String, _>("filename"),
        _ => filename.clone(),
    };

    let image_path = PathBuf::from(&state.images_dir).join(&original_filename);
    if !image_path.exists() { return (StatusCode::NOT_FOUND, "Not Found").into_response(); }

    let t_path = thumb_path.clone();
    let i_path = image_path.clone();

    // Spawn the task using our new orientation-aware function
    let res = tokio::task::spawn_blocking(move || {
        generate_oriented_thumbnail(&i_path, &t_path)
    }).await;

    if res.is_ok() && res.unwrap() {
        if let Ok(bytes) = fs::read(&thumb_path) { 
            return ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(); 
        }
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}




async fn delete_image(State(state): State<AppState>, Json(req): Json<DeleteRequest>) -> impl IntoResponse {
    if req.password.as_deref() != Some(&state.master_password) { return (StatusCode::UNAUTHORIZED).into_response(); }
    let _ = sqlx::query("DELETE FROM images WHERE filename = ?;").bind(&req.filename).execute(&state.db).await;
    let _ = fs::remove_file(PathBuf::from(&state.images_dir).join(&req.filename));
    if let Some(p) = req.filename.rfind('.') {
        let _ = fs::remove_file(PathBuf::from(&state.thumbnails_dir).join(format!("{}.jpg", &req.filename[..p])));
    }
    StatusCode::OK.into_response()
}

async fn get_albums_list(State(state): State<AppState>) -> impl IntoResponse {
    if let Ok(items) = sqlx::query("SELECT name FROM albums ORDER BY name ASC;").fetch_all(&state.db).await {
        let albums: Vec<String> = items.iter().map(|r| r.get::<String, _>("name")).collect();
        return Json(AlbumListResponse { albums }).into_response();
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}


// 🛠️ FIX: Correct matching on TagValue variants for the rexif crate
fn generate_oriented_thumbnail(img_path: &std::path::Path, thumb_path: &std::path::Path) -> bool {
    let mut raw_img = match image::open(img_path) {
        Ok(img) => img,
        Err(_) => return false,
    };

    // Attempt to read EXIF data to check for orientation tags
    if let Ok(metadata) = rexif::parse_file(img_path) {
        for entry in metadata.entries {
            if entry.tag == rexif::ExifTag::Orientation {
                let mut orientation_value = 1;

                // Match directly against rexif's actual TagValue variants
                match &entry.value {
                    rexif::TagValue::U16(vec) => {
                        if let Some(&val) = vec.first() { orientation_value = val; }
                    }
                    rexif::TagValue::U32(vec) => {
                        if let Some(&val) = vec.first() { orientation_value = val as u16; }
                    }
                    rexif::TagValue::I16(vec) => {
                        if let Some(&val) = vec.first() { orientation_value = val as u16; }
                    }
                    rexif::TagValue::I32(vec) => {
                        if let Some(&val) = vec.first() { orientation_value = val as u16; }
                    }
                    _ => {} // Fallback for unmatched types
                }

                // Rotate the image buffer based on standard EXIF Orientation definitions
                raw_img = match orientation_value {
                    3 => raw_img.rotate180(),
                    6 => raw_img.rotate90(),
                    8 => raw_img.rotate270(),
                    _ => raw_img, // 1 is normal layout orientation
                };
                break;
            }
        }
    }

    // Generate a clean 300x300 thumbnail with corrected rotation
    let thumbnail = raw_img.thumbnail(300, 300);
    thumbnail.save_with_format(thumb_path, image::ImageFormat::Jpeg).is_ok()
}