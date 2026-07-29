use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    extract::ws::{WebSocket, WebSocketUpgrade},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
    
    
};




use std::process::Command;

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::ServeDir;
use tower::ServiceBuilder;
use sqlx::{SqlitePool, Row};

use tokio::sync::{broadcast, Semaphore};






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



#[derive(Debug, Deserialize)]
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
#[derive(Serialize, Deserialize, Clone, Debug)]
struct UploadResponse {
    // 🎯 Use a Serde fallback default so if "action" is missing, it automatically becomes "upload"
    #[serde(default = "default_action")]
    action: String,
    filename: String,
    album: String,
}

// ⚙️ Helper helper function to supply the fallback string literal value
fn default_action() -> String {
    "upload".to_string()
}

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    images_dir: String,
    thumbnails_dir: String,
    tx: broadcast::Sender<UploadResponse>,
    master_password: String,
    // 🆕 Limit concurrent heavy CPU work (e.g., max 2 processing threads)
    cpu_semaphore: Arc<Semaphore>,
}


// 1. Embed the binary bytes of favicon.ico at compile time
const FAVICON_ICO: &[u8] = include_bytes!("../static/favicon.ico");

// 2. Create the handler function
async fn favicon_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/x-icon")], FAVICON_ICO)
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

    // 🎯 FIX: Instead of hardcoding "sqlite://gallery.db", dynamically pick the path based on environment
    let db_url = if is_termux {
        "sqlite:///data/data/com.termux/files/home/gallery.db".to_string()
    } else {
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://gallery.db".to_string())
    };

    // 🛠️ SAFETY CHECK: Strip the protocol and touch the file if it's completely missing
    if let Some(clean_path) = db_url.strip_prefix("sqlite://") {
        let db_path = std::path::Path::new(clean_path);
        if !db_path.exists() {
            println!("Database file missing. Provisioning fresh instance at: {:?}", db_path);
            if let Some(parent) = db_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::File::create(db_path);
        }
    }

    println!("Connecting to database string: {}", db_url);

    // 🚀 Now connect using our dynamic db_url variable instead of the hardcoded literal
    let db = SqlitePool::connect(&db_url)
        .await
        .expect("Failed to connect to SQLite");

    // 🎯 AUTO-INITIALIZATION: Recreate tables if they don't exist
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            file_size INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );"
    )
    .execute(&db)
    .await
    .expect("Failed to initialize images table layout");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS albums (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );"
    )
    .execute(&db)
    .await
    .expect("Failed to initialize albums table layout");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS image_albums (
            image_id INTEGER NOT NULL,
            album_id INTEGER NOT NULL,
            PRIMARY KEY (image_id, album_id),
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
            FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
        );"
    )
    .execute(&db)
    .await
    .expect("Failed to initialize image_albums structural mapping table");



  
    // --- 📂 STARTUP STORAGE SYNCHRONIZATION LOOP ---
    println!("Scanning image directory for untracked filesystem assets...");
    if let Ok(entries) = fs::read_dir(&images_dir) { // 🎯 Fixed variable name to match your code
        for entry in entries.flatten() {
            let path = entry.path();
            
            if path.is_file() {
                if let Some(filename_os) = path.file_name() {
                    let filename = filename_os.to_string_lossy().into_owned();
                    
                    if filename.starts_with('.') { continue; }

                    // 1. Verify if this file already exists in our database registry
                    let exists_row = sqlx::query("SELECT 1 FROM images WHERE filename = ? LIMIT 1;")
                        .bind(&filename)
                        .fetch_optional(&db)
                        .await;

                    if let Ok(None) = exists_row {
                        println!("Found untracked file: {}. Cataloging to database...", filename);
                        
                        // 2. Read physical metadata sizes safely
                        let file_size = fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                        
                        // 3. Fallback timestamp sequence tracking
                        let created_at = fs::metadata(&path)
                            .and_then(|m| m.created())
                            .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                            .unwrap_or_else(|_| {
                                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
                            });

                        // 4. Register the asset row into the database layout
                        let _ = sqlx::query(
                            "INSERT INTO images (filename, created_at, file_size) VALUES (?, ?, ?);"
                        )
                        .bind(&filename)
                        .bind(created_at)
                        .bind(file_size)
                        .execute(&db)
                        .await;
                    }
                }
            }
        }
    }
    println!("Filesystem sync check complete!");


    

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
        // 🎯 Restrict CPU image processing to 2 concurrent worker tasks
    cpu_semaphore: Arc::new(Semaphore::new(2)),
    };

    let app = Router::new()
        .route("/", get(move || async move { Html(index_html_content) }))
        .route("/favicon.ico", get(favicon_handler))
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
        .route("/api/images/manifest", get(get_image_manifest))
       
      .route("/:album_name", get(vanity_album_index))
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
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut password_provided = String::new();
    let mut album_tag: Option<String> = None;

    // Parse incoming multipart data
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "password" => {
                if let Ok(text) = field.text().await { password_provided = text; }
            }
            "album" => {
                if let Ok(text) = field.text().await {
                    let text_val = text.trim().to_string();
                    if !text_val.is_empty() { album_tag = Some(text_val); }
                }
            }
            "image" | "images" | "files" => {
                let filename = field.file_name().unwrap_or("uploaded.jpg").to_string();
                if let Ok(bytes) = field.bytes().await {
                    if !bytes.is_empty() { files.push((filename, bytes.to_vec())); }
                }
            }
            _ => {}
        }
    }

    if password_provided != state.master_password {
        return (StatusCode::UNAUTHORIZED, "Incorrect master password").into_response();
    }

    if files.is_empty() {
        return (StatusCode::BAD_REQUEST, "No files provided").into_response();
    }

    let clean_album = album_tag.unwrap_or_default();

    // 🚀 Fast-path: Save raw files to disk instantly
    let mut queued_files = Vec::new();

    for (filename, file_data) in files {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let unique_filename = format!("{}_{}", timestamp, filename);
        let save_path = PathBuf::from(&state.images_dir).join(&unique_filename);

        if fs::write(&save_path, &file_data).is_ok() {
            queued_files.push((unique_filename, save_path, file_data.len() as i64));
        }
    }

    // 🎯 Spawn background processing task (doesn't block the HTTP response)
    let state_clone = state.clone();
    let album_clone = clean_album.clone();

    tokio::spawn(async move {
        for (unique_filename, save_path, file_size) in queued_files {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            let clean_stem = unique_filename
                .rfind('.')
                .map(|p| &unique_filename[..p])
                .unwrap_or(&unique_filename);
            
            let thumb_path = PathBuf::from(&state_clone.thumbnails_dir).join(format!("{}.jpg", clean_stem));
            
            let media_path_clone = save_path.clone();
            let semaphore = state_clone.cpu_semaphore.clone();

            // 💡 Check file extension to detect video vs image
            let ext = unique_filename
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_lowercase();
                
            let is_video = matches!(ext.as_str(), "mp4" | "webm" | "mov" | "mkv" | "avi");

            // 💡 FIX: Clone unique_filename specifically for use inside the closure
let filename_for_log = unique_filename.clone();

            // Perform thumbnail extraction in background thread pool
          
            // Perform thumbnail extraction in background thread pool
tokio::task::spawn_blocking(move || {
    let _permit = semaphore.try_acquire();
    
    if is_video {
        // 🎬 Extract frame at 1 sec mark using FFmpeg
        let status = Command::new("ffmpeg")
            .args(&[
                "-ss", "00:00:01",
                "-i", media_path_clone.to_str().unwrap_or_default(),
                "-vframes", "1",
                "-vf", "scale=400:-1",
                "-q:v", "3",
                "-y",
                thumb_path.to_str().unwrap_or_default(),
            ])
            .status();

        if status.is_err() || !status.unwrap().success() {
            // 💡 Uses filename_for_log moved into closure
            eprintln!("⚠️ FFmpeg thumbnail extraction failed for {}", filename_for_log);
        }
    } else {
        // 🖼️ Standard Image Thumbnail Extraction
        generate_oriented_thumbnail(&media_path_clone, &thumb_path);
    }
}).await.ok();

// 💡 `unique_filename` remains untouched and valid for your SQLite insert & WS broadcast below!
let insert_res = sqlx::query(
    "INSERT INTO images (filename, created_at, file_size) VALUES (?, ?, ?);"
)

            .bind(&unique_filename)
            .bind(timestamp)
            .bind(file_size)
            .execute(&state_clone.db)
            .await;

            if let Ok(result) = insert_res {
                let image_id = result.last_insert_rowid();

                if !album_clone.is_empty() {
                    let _ = sqlx::query("INSERT OR IGNORE INTO albums (name) VALUES (?);")
                        .bind(&album_clone)
                        .execute(&state_clone.db)
                        .await;

                    if let Ok(row) = sqlx::query("SELECT id FROM albums WHERE name = ?;")
                        .bind(&album_clone)
                        .fetch_one(&state_clone.db)
                        .await
                    {
                        let album_id: i64 = row.get(0);
                        let _ = sqlx::query("INSERT OR IGNORE INTO image_albums (image_id, album_id) VALUES (?, ?);")
                            .bind(image_id)
                            .bind(album_id)
                            .execute(&state_clone.db)
                            .await;
                    }
                }

                // 📡 Broadcast live update over WebSocket as EACH media item finishes
                let response_payload = UploadResponse {
                    action: "upload".to_string(),
                    filename: unique_filename,
                    album: album_clone.clone(),
                };

                let _ = state_clone.tx.send(response_payload);
            }
        }
    });

    // ⚡ Return IMMEDIATELY to the user interface
    (StatusCode::OK, Json(serde_json::json!({ "status": "queued" }))).into_response()
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
            action: "upload".to_string(),
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
    // let mut query_str = "
    //     SELECT i.filename, COALESCE(a.name, '') as album_name 
    //     FROM images i
    //     LEFT JOIN image_albums ia ON i.id = ia.image_id
    //     LEFT JOIN albums a ON ia.album_id = a.id
    //     WHERE 1=1
    // ".to_string();

  let mut query_str = "
        SELECT 
            i.filename,
            COALESCE(a.name, '') as album_name ,
            COUNT(*) OVER() as total_count
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
        SELECT COUNT(DISTINCT i.id) 
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

 async fn get_thumbnail(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let thumb_path = PathBuf::from(&state.thumbnails_dir).join(&filename);

    // Async file check
    if tokio::fs::try_exists(&thumb_path).await.unwrap_or(false) {
        if let Ok(bytes) = tokio::fs::read(&thumb_path).await {
            return ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response();
        }
    }

    // Fallback DB lookup
    let base_stem = filename.rfind('.').map(|p| &filename[..p]).unwrap_or(&filename);
    let search_pattern = format!("{}.%", base_stem);

    let original_filename: String = sqlx::query("SELECT filename FROM images WHERE filename LIKE ? LIMIT 1")
        .bind(&search_pattern)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|row| row.get("filename"))
        .unwrap_or(filename.clone());

    let image_path = PathBuf::from(&state.images_dir).join(&original_filename);
    if !tokio::fs::try_exists(&image_path).await.unwrap_or(false) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    // Generate thumbnail in blocking task
    let res = tokio::task::spawn_blocking({
        let i_path = image_path.clone();
        let t_path = thumb_path.clone();
        move || generate_oriented_thumbnail(&i_path, &t_path)
    }).await;

    match res {
        Ok(true) => {
            if let Ok(bytes) = tokio::fs::read(&thumb_path).await {
                ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response()
            } else {
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}





async fn delete_image(
    State(state): State<AppState>, 
    Json(req): Json<DeleteRequest>
) -> impl IntoResponse {
    // 1. Authenticate using your master password check
    if req.password.as_deref() != Some(&state.master_password) { 
        return (StatusCode::UNAUTHORIZED).into_response(); 
    }

    // 🎯 Clone the filename now so we have a clean copy for the WebSocket broadcast later
    let filename_for_ws = req.filename.clone();

    // 2. Remove the row from the SQLite database registry
    let _ = sqlx::query("DELETE FROM images WHERE filename = ?;")
        .bind(&req.filename)
        .execute(&state.db)
        .await;

    // 3. Delete the original full-size image from disk safely
    let _ = fs::remove_file(PathBuf::from(&state.images_dir).join(&req.filename));

    // 4. Delete the companion thumbnail from disk cleanly (converting the extension to .jpg)
    if let Some(p) = req.filename.rfind('.') {
        let _ = fs::remove_file(
            PathBuf::from(&state.thumbnails_dir).join(format!("{}.jpg", &req.filename[..p]))
        );
    }

    // 🎯 5. BROADCAST: Send the live deletion event signal to all active WebSocket users!
    let delete_payload = UploadResponse {
        action: "delete".to_string(),
        filename: filename_for_ws,
        album: "".to_string(), // Empty string placeholder since it's going away
    };
    let _ = state.tx.send(delete_payload);

    StatusCode::OK.into_response()
}







async fn get_albums_list(State(state): State<AppState>) -> impl IntoResponse {
    if let Ok(items) = sqlx::query("SELECT name FROM albums ORDER BY name ASC;").fetch_all(&state.db).await {
        let albums: Vec<String> = items.iter().map(|r| r.get::<String, _>("name")).collect();
        return Json(AlbumListResponse { albums }).into_response();
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}



use image::imageops::FilterType;

fn generate_oriented_thumbnail(img_path: &std::path::Path, thumb_path: &std::path::Path) -> bool {
    let mut raw_img = match image::open(img_path) {
        Ok(img) => img,
        Err(_) => return false,
    };

    // Check EXIF Orientation tags
    if let Ok(metadata) = rexif::parse_file(img_path) {
        for entry in metadata.entries {
            if entry.tag == rexif::ExifTag::Orientation {
                let mut orientation_value = 1;

                match &entry.value {
                    rexif::TagValue::U16(vec) => { if let Some(&val) = vec.first() { orientation_value = val; } }
                    rexif::TagValue::U32(vec) => { if let Some(&val) = vec.first() { orientation_value = val as u16; } }
                    rexif::TagValue::I16(vec) => { if let Some(&val) = vec.first() { orientation_value = val as u16; } }
                    rexif::TagValue::I32(vec) => { if let Some(&val) = vec.first() { orientation_value = val as u16; } }
                    _ => {}
                }

                raw_img = match orientation_value {
                    3 => raw_img.rotate180(),
                    6 => raw_img.rotate90(),
                    8 => raw_img.rotate270(),
                    _ => raw_img,
                };
                break;
            }
        }
    }

    // 🎯 Fast downscaling filter (Triangle is ~4x faster than Lanczos3)
    let thumbnail = raw_img.resize_to_fill(300, 300, FilterType::Triangle);
    thumbnail.save_with_format(thumb_path, image::ImageFormat::Jpeg).is_ok()
}





async fn vanity_album_index(axum::extract::Path(_album_name): axum::extract::Path<String>) -> impl axum::response::IntoResponse {
    let index_html_content = include_str!("../static/index.html");
    axum::response::Html(index_html_content)
}


/// Handler that returns a light JSON array of all image filenames

pub async fn get_image_manifest() -> impl IntoResponse {
    // Check ./images relative path
    let images_dir = std::path::Path::new("./images");

    let mut filenames: Vec<String> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(images_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif") {
                        if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
                            filenames.push(filename.to_string());
                        }
                    }
                }
            }
        }
    } else {
        eprintln!("⚠️ [MANIFEST] Failed to read directory ./images from execution path: {:?}", std::env::current_dir());
    }

    // Sort filenames
    filenames.sort();
    
    println!("📸 [MANIFEST] Found {} total images.", filenames.len());

    (StatusCode::OK, Json(filenames))
}