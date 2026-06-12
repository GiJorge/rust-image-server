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
    images: Vec<String>,
    has_more: bool,
}

#[derive(Serialize, Clone)]
struct UploadResponse {
    filename: String,
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
        println!("📱 Production Environment Detected (Termux)");
        (
            "/data/data/com.termux/files/home/images".to_string(),
            "/data/data/com.termux/files/home/thumb".to_string()
        )
    } else {
        println!("💻 Development Environment Detected (Debian)");
        (
            std::env::var("IMAGES_DIR").unwrap_or_else(|_| "./images".to_string()),
            std::env::var("THUMBNAILS_DIR").unwrap_or_else(|_| "./thumb".to_string())
        )
    };

    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://gallery.db".to_string());

    if !std::path::Path::new(&images_dir).exists() {
        let _ = fs::create_dir_all(&images_dir);
    }
    if !std::path::Path::new(&thumbnails_dir).exists() {
        let _ = fs::create_dir_all(&thumbnails_dir);
    }

    let db_filename = db_url.replace("sqlite://", "");
    let db_pool = SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_filename)
            .create_if_missing(true)
    )
    .await
    .unwrap();


        sqlx::query(
            "CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                thumbnail_filename TEXT
            );"
        )
        .execute(&db_pool)
        .await
        .unwrap();

        // 🆕 Create the Albums lookup table
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS albums (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );"
        )
        .execute(&db_pool)
        .await
        .unwrap();

        // 🆕 Create the Many-to-Many Bridge Table
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS image_albums (
                image_id INTEGER,
                album_id INTEGER,
                PRIMARY KEY (image_id, album_id),
                FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
                FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
            );"
        )
        .execute(&db_pool)
        .await
        .unwrap();

    let _ = sqlx::query("ALTER TABLE images ADD COLUMN thumbnail_filename TEXT;").execute(&db_pool).await;

    // --- SAFE STARTUP SCANNING ---
    if let Ok(entries) = fs::read_dir(&images_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                let lower_name = name.to_lowercase();
                if lower_name.ends_with(".jpg") ||
                   lower_name.ends_with(".jpeg") ||
                   lower_name.ends_with(".png") ||
                   lower_name.ends_with(".gif") ||
                   lower_name.ends_with(".webp") {

                    let already_exists = sqlx::query("SELECT 1 FROM images WHERE filename = ?")
                        .bind(name)
                        .fetch_optional(&db_pool)
                        .await
                        .map(|opt| opt.is_some())
                        .unwrap_or(false);

                    if !already_exists {
                        let metadata = entry.metadata().ok();
                        let size = metadata.as_ref().map(|m| m.len() as i64).unwrap_or(0);

                        let file_time = metadata.as_ref()
                            .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or_else(|| {
                                SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
                            });

                        let expected_thumb = match name.rfind('.') {
                            Some(pos) => format!("{}.webp", &name[..pos]),
                            None => format!("{}.webp", name),
                        };

                        let _ = sqlx::query(
                            "INSERT OR IGNORE INTO images (filename, created_at, file_size, thumbnail_filename) VALUES (?, ?, ?, ?)"
                        )
                        .bind(name)
                        .bind(file_time)
                        .bind(size)
                        .bind(expected_thumb)
                        .execute(&db_pool)
                        .await;
                    }
                }
            }
        }
    }

    let master_password = std::env::var("MASTER_PASSWORD").unwrap_or_else(|_| "@jo111".to_string());
    let (tx, _rx) = broadcast::channel(16);
    let index_html_content = include_str!("../static/index.html");
    let style_css_content = include_str!("../static/style.css");
    let app_js_content = include_str!("../static/app.js");

    let state = AppState {
        db: db_pool,
        images_dir: images_dir.clone(),
        thumbnails_dir: thumbnails_dir.clone(),
        tx,
        master_password,
    };

    let app = Router::new()
        .route("/", get(move || async move { Html(index_html_content) }))
        // 🆕 Serve the CSS asset dynamically from the binary memory
        .route("/static/style.css", get(move || async move {
            ([(axum::http::header::CONTENT_TYPE, "text/css")], style_css_content)
        }))
        
        // 🆕 Serve the JS asset dynamically from the binary memory
        .route("/static/app.js", get(move || async move {
            ([(axum::http::header::CONTENT_TYPE, "application/javascript")], app_js_content)
        }))

        .route("/api/albums", get(get_albums_list))
        .route("/api/images", get(get_images_json))
        .route("/api/upload", post(upload_image))
        .route("/api/ws", get(ws_handler))
        .route("/thumb/:filename", get(get_thumbnail))
        .route("/api/delete", post(delete_image))
        .nest_service("/images", ServeDir::new(&images_dir))
        .with_state(state)
        .layer(
            ServiceBuilder::new()
                .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        );

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

    // 1. Parse the incoming multi-part data stream
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();

        match name.as_str() {
            "password" => {
                password_provided = field.text().await.unwrap();
            }
            "album" => {
                let text_val = field.text().await.unwrap().trim().to_string();
                if !text_val.is_empty() {
                    album_tag = Some(text_val);
                }
            }
            "image" => {
                filename = field.file_name().unwrap().to_string();
                file_data = field.bytes().await.unwrap().to_vec();
            }
            _ => {}
        }
    }

    // 2. Authentication Verification
    if password_provided != state.master_password {
        return (StatusCode::UNAUTHORIZED, "Incorrect master password").into_response();
    }

    if file_data.is_empty() || filename.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing file data asset payload").into_response();
    }

    // 3. Save the original file with a unique timestamp prefix
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let unique_filename = format!("{}_{}", timestamp, filename);
    let save_path = PathBuf::from(&state.images_dir).join(&unique_filename);

    if let Err(e) = fs::write(&save_path, &file_data) {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save file: {}", e)).into_response();
    }

    let file_size = file_data.len() as i64;

    



    // 4. Clean & Light Thumbnail Compression (Center cropped square 300x300 JPEG)
    let thumb_filename = match image::load_from_memory(&file_data) {
        Ok(img) => {
            // High-quality fast scale
            let thumb = img.resize_to_fill(300, 300, image::imageops::FilterType::Lanczos3);
            
            let path_obj = std::path::Path::new(&unique_filename);
            let file_stem = path_obj.file_stem().unwrap_or_default().to_string_lossy();
            
            // 📁 Change target extension to .jpg
            let target_thumb_name = format!("{}.jpg", file_stem);
            let thumb_path = PathBuf::from(&state.thumbnails_dir).join(&target_thumb_name);
            
            // Open standard file handle stream
            match std::fs::File::create(&thumb_path) {
                Ok(file) => {
                    use image::codecs::jpeg::JpegEncoder;
                    
                    // 🛠️ PERFECT COMPRESSION: Set JPEG quality to 75% 
                    // This is lightning fast on CPU and outputs a tiny ~10KB file!
                    let encoder = JpegEncoder::new_with_quality(file, 75);
                    
                    match thumb.write_with_encoder(encoder) {
                        Ok(_) => Some(target_thumb_name),
                        Err(e) => {
                            println!("⚠️ Thumbnail JPEG encode failed: {}", e);
                            None
                        }
                    }
                }
                Err(e) => {
                    println!("⚠️ Failed to create thumbnail file handle: {}", e);
                    None
                }
            }
        }
        Err(e) => {
            println!("⚠️ Failed to parse image memory: {}", e);
            None
        }
    };




    // 5. Database Transaction Persistence
    let insert_res = sqlx::query(
        "INSERT INTO images (filename, created_at, file_size, thumbnail_filename) VALUES (?, ?, ?, ?);"
    )
    .bind(&unique_filename)
    .bind(timestamp as i64)
    .bind(file_size)
    .bind(&thumb_filename)
    .execute(&state.db)
    .await;

    match insert_res {
        Ok(result) => {
            let image_id = result.last_insert_rowid();

            // Link Album relations
            if let Some(ref name) = album_tag {
                let _ = sqlx::query("INSERT OR IGNORE INTO albums (name) VALUES (?);")
                    .bind(name)
                    .execute(&state.db)
                    .await;

                if let Ok(album_row) = sqlx::query("SELECT id FROM albums WHERE name = ?;")
                    .bind(name)
                    .fetch_one(&state.db)
                    .await 
                {
                    let album_id: i64 = album_row.get(0);
                    let _ = sqlx::query("INSERT OR IGNORE INTO image_albums (image_id, album_id) VALUES (?, ?);")
                        .bind(image_id)
                        .bind(album_id)
                        .execute(&state.db)
                        .await;
                }
            }

            // Dispatch WebSocket update
            let response_payload = UploadResponse { filename: unique_filename };
            let _ = state.tx.send(response_payload.clone());

            Json(response_payload).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", err)).into_response(),
    }
}











async fn get_images_json(
    State(state): State<AppState>,
    pagination: Query<ImageQuery>,
) -> impl IntoResponse {
    let offset = pagination.offset as i64;
    let limit = pagination.limit as i64;

    let mut query_str = "SELECT i.filename FROM images i".to_string();
    
    // If an album is requested, inject an inner join to filter results
    if pagination.album.is_some() {
        query_str.push_str(" JOIN image_albums ia ON i.id = ia.image_id JOIN albums a ON ia.album_id = a.id");
    }

    query_str.push_str(" WHERE 1=1");

    if pagination.album.is_some() {
        query_str.push_str(" AND a.name = ?");
    }
    if pagination.search.is_some() {
        query_str.push_str(" AND i.filename LIKE ?");
    }
    if pagination.min_size.is_some() {
        query_str.push_str(" AND i.file_size >= ?");
    }
    if pagination.max_size.is_some() {
        query_str.push_str(" AND i.file_size <= ?");
    }

    // Sort order handling
    let sort_order = pagination.sort.as_deref().unwrap_or("recent");
    if sort_order == "oldest" {
        query_str.push_str(" ORDER BY i.created_at ASC, i.id ASC");
    } else {
        query_str.push_str(" ORDER BY i.created_at DESC, i.id DESC");
    }
    query_str.push_str(" LIMIT ? OFFSET ?;");

    let mut db_query = sqlx::query(&query_str);

    // Bind parameters dynamically in chronological order of appearance
    if let Some(ref alb) = pagination.album { db_query = db_query.bind(alb); }
    if let Some(ref s) = pagination.search { db_query = db_query.bind(format!("%{}%", s)); }
    if let Some(min) = pagination.min_size { db_query = db_query.bind(min); }
    if let Some(max) = pagination.max_size { db_query = db_query.bind(max); }
    
    db_query = db_query.bind(limit).bind(offset);

    let rows = db_query.fetch_all(&state.db).await.unwrap();
    let images: Vec<String> = rows.iter().map(|r| r.get::<String, _>("filename")).collect();

    // Check if there are more images available for pagination
    let mut count_str = "SELECT COUNT(*) FROM images i".to_string();
    if pagination.album.is_some() {
        count_str.push_str(" JOIN image_albums ia ON i.id = ia.image_id JOIN albums a ON ia.album_id = a.id WHERE a.name = ?");
    } else {
        count_str.push_str(" WHERE 1=1");
    }
    
    let mut count_query = sqlx::query(&count_str);
    if let Some(ref alb) = pagination.album { count_query = count_query.bind(alb); }
    let total_count: i64 = count_query.fetch_one(&state.db).await.unwrap().get(0);
    
    // 🔍 FIXED: Changed .length() to .len() here
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
        if socket.send(axum::extract::ws::Message::Text(json_msg.into())).await.is_err() {
            break;
        }
    }
}

async fn get_thumbnail(
    State(state): State<AppState>,
    Path(filename): Path<String>
) -> impl IntoResponse {
    let thumb_path = PathBuf::from(&state.thumbnails_dir).join(&filename);

    if thumb_path.exists() {
        if let Ok(bytes) = fs::read(&thumb_path) {
            return ([(header::CONTENT_TYPE, "image/webp")], bytes).into_response();
        }
    }

    let base_stem = match filename.rfind('.') {
        Some(pos) => &filename[..pos],
        None => &filename,
    };

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

    if !image_path.exists() {
        eprintln!("THUMBNAIL ERROR: Original source file not found at {:?}", image_path);
        return (StatusCode::NOT_FOUND, "Original image source file not found").into_response();
    }

    let t_path = thumb_path.clone();
    let i_path = image_path.clone();

    println!("⚡ Compressing brand new thumbnail for: {}", original_filename);

    let res = tokio::task::spawn_blocking(move || {
        match image::open(&i_path) {
            Ok(raw_img) => {
                let oriented_img = auto_orient_image(&i_path, raw_img);
                let thumbnail = oriented_img.thumbnail(200, 200);
                thumbnail.save_with_format(&t_path, image::ImageFormat::WebP)
                    .map_err(|e| format!("{}", e))
            }
            Err(e) => Err(format!("{}", e))
        }
    }).await;

    if res.is_err() || res.unwrap().is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to process image compression").into_response();
    }

    let _ = sqlx::query("UPDATE images SET thumbnail_filename = ? WHERE filename = ?")
        .bind(&filename)
        .bind(&original_filename)
        .execute(&state.db)
        .await;

    match fs::read(&thumb_path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/webp")], bytes).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read generated thumbnail").into_response(),
    }
}

fn auto_orient_image(image_path: &std::path::Path, mut img: image::DynamicImage) -> image::DynamicImage {
    let file = match std::fs::File::open(image_path) {
        Ok(f) => f,
        Err(_) => return img,
    };

    let mut bufreader = std::io::BufReader::new(file);
    let exifreader = exif::Reader::new();

    if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
        if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
            if let Some(orientation_value) = field.value.get_uint(0) {
                img = match orientation_value {
                    3 => img.rotate180(),
                    6 => img.rotate90(),
                    8 => img.rotate270(),
                    _ => img,
                };
            }
        }
    }
    img
}

async fn delete_image(
    State(state): State<AppState>,
    Json(req): Json<DeleteRequest>,
) -> impl IntoResponse {
    if req.password.as_deref() != Some(&state.master_password) {
        return (StatusCode::UNAUTHORIZED, "Incorrect master password").into_response();
    }

    let filename = &req.filename;

    let db_result = sqlx::query("DELETE FROM images WHERE filename = ?")
        .bind(filename)
        .execute(&state.db)
        .await;

    if let Err(e) = db_result {
        println!("Database deletion error: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete from database").into_response();
    }

    let image_path = PathBuf::from(&state.images_dir).join(filename);
    if let Err(e) = fs::remove_file(&image_path) {
        println!("Warning: Could not delete raw image file {:?}: {}", image_path, e);
    }

    if let Some(dot_pos) = filename.rfind('.') {
        let base_name = &filename[..dot_pos];
        let thumb_path = PathBuf::from(&state.thumbnails_dir).join(format!("{}.webp", base_name));

        if let Err(e) = fs::remove_file(&thumb_path) {
            println!("Warning: Could not delete thumbnail file {:?}: {}", thumb_path, e);
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "success", "filename": filename }))
    ).into_response()
}


// 🆕 Fetch the clean list of all categories currently in use
async fn get_albums_list(State(state): State<AppState>) -> impl IntoResponse {
    let rows = sqlx::query("SELECT name FROM albums ORDER BY name ASC;")
        .fetch_all(&state.db)
        .await;

    match rows {
        Ok(items) => {
            let albums: Vec<String> = items.iter().map(|r| r.get::<String, _>("name")).collect();
            Json(AlbumListResponse { albums }).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read categories").into_response(),
    }
}

