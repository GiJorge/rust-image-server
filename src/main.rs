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
    password: String,
}

#[derive(Deserialize)]
struct ImageQuery {
    offset: usize,
    limit: usize,
    search: Option<String>,
    sort: Option<String>,
    min_size: Option<i64>,
    max_size: Option<i64>,
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

    // 1. Environment-Aware Path Auto-Detection
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

    // Safe Directory Guard Check: Prevents Android from resetting or wiping the directory out on boot
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

    let _ = sqlx::query("ALTER TABLE images ADD COLUMN thumbnail_filename TEXT;").execute(&db_pool).await;



// --- SAFE STARTUP SCANNING ---
    println!("🔄 Running startup synchronization scan...");
    if let Ok(entries) = fs::read_dir(&images_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                let lower_name = name.to_lowercase();
                if lower_name.ends_with(".jpg") ||
                   lower_name.ends_with(".jpeg") ||
                   lower_name.ends_with(".png") ||
                   lower_name.ends_with(".gif") ||
                   lower_name.ends_with(".webp") {

                    // 1. Check if this file is ALREADY tracked in the database
                    let already_exists = sqlx::query("SELECT 1 FROM images WHERE filename = ?")
                        .bind(name)
                        .fetch_optional(&db_pool)
                        .await
                        .map(|opt| opt.is_some())
                        .unwrap_or(false);

                    // 2. Only touch the file if the database has absolutely no record of it
                    if !already_exists {
                        println!("🆕 Found untracked local image: {}", name);
                        
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

                        // Insert the new file into the database so it's tracked instantly
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
    println!("✅ Startup scan finished.");


    let master_password = std::env::var("MASTER_PASSWORD").unwrap_or_else(|_| "@jo111".to_string());
    let (tx, _rx) = broadcast::channel(16);
    let index_html_content = include_str!("../static/index.html");

    let state = AppState {
        db: db_pool,
        images_dir: images_dir.clone(),
        thumbnails_dir: thumbnails_dir.clone(),
        tx,
        master_password,
    };

    let app = Router::new()
        .route("/", get(move || async move { Html(index_html_content) }))
        .route("/api/images", get(get_images_json))
        .route("/api/upload", post(upload_image))
        .route("/api/ws", get(ws_handler))
        .route("/thumb/:filename", get(get_thumbnail)) // URL updated to reflect clean name context
        .route("/api/delete", axum::routing::post(delete_image))
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
    let master_password = &state.master_password;
    let mut password_provided = String::new();
    let mut image_field_data: Option<(String, axum::body::Bytes)> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();

        if name == "password" {
            if let Ok(text) = field.text().await {
                password_provided = text;
            }
        } else if name == "image" {
            let file_name = field.file_name().unwrap_or_default().to_string();
            if !file_name.is_empty() {
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".jpg") ||
                   lower_name.ends_with(".jpeg") ||
                   lower_name.ends_with(".png") ||
                   lower_name.ends_with(".gif") ||
                   lower_name.ends_with(".webp") {

                    if let Ok(data) = field.bytes().await {
                        image_field_data = Some((file_name, data));
                    }
                }
            }
        }
    }

    if &password_provided != master_password {
        return (StatusCode::UNAUTHORIZED, "Incorrect upload password").into_response();
    }

    if let Some((file_name, data)) = image_field_data {
        let file_size = data.len() as i64;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let unique_file_name = format!("{}_{}", timestamp, file_name);
        let path = PathBuf::from(&state.images_dir).join(&unique_file_name);

        let write_res = tokio::task::spawn_blocking(move || {
            fs::write(path, data)
        }).await;

        if write_res.is_err() || write_res.unwrap().is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save file to disk".to_string()).into_response();
        }

        let expected_thumb = match unique_file_name.rfind('.') {
            Some(pos) => format!("{}.webp", &unique_file_name[..pos]),
            None => format!("{}.webp", unique_file_name),
        };

        let db_res = sqlx::query(
            "INSERT INTO images (filename, created_at, file_size, thumbnail_filename) VALUES (?, ?, ?, ?)"
        )
        .bind(&unique_file_name)
        .bind(timestamp)
        .bind(file_size)
        .bind(&expected_thumb)
        .execute(&state.db)
        .await;

        if let Err(err) = db_res {
            eprintln!("DATABASE UPLOAD ERROR: {}", err);
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("Database injection failed: {}", err)).into_response();
        }

        let upload_info = UploadResponse { filename: unique_file_name.clone() };
        let _ = state.tx.send(upload_info);

        return (StatusCode::OK, Json(UploadResponse { filename: unique_file_name })).into_response();
    }

    (StatusCode::BAD_REQUEST, "No valid image found").into_response()
}

async fn get_images_json(
    State(state): State<AppState>,
    pagination: Query<ImageQuery>,
) -> impl IntoResponse {
    let offset = pagination.offset as i64;
    let limit = pagination.limit as i64;

    let mut conditions = Vec::new();

    if let Some(ref search) = pagination.search {
        if !search.trim().is_empty() {
            conditions.push(format!("filename LIKE '%{}%'", search.replace('\'', "''")));
        }
    }
    if let Some(min) = pagination.min_size {
        conditions.push(format!("file_size >= {}", min));
    }
    if let Some(max) = pagination.max_size {
        conditions.push(format!("file_size <= {}", max));
    }

    let where_clause = if conditions.is_empty() {
        "".to_string()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sort_order = match pagination.sort.as_deref() {
        Some("oldest") => "created_at ASC",
        _ => "created_at DESC",
    };

    let base_query = format!(
        "SELECT filename FROM images {} ORDER BY {} LIMIT {} OFFSET {}",
        where_clause, sort_order, limit, offset
    );

    let rows_res = sqlx::query(&base_query).fetch_all(&state.db).await;

    let rows = match rows_res {
        Ok(r) => r,
        Err(err) => {
            eprintln!("DATABASE QUERY ERROR: {}", err);
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("Database query failed: {}", err)).into_response();
        }
    };

    let mut images = Vec::new();
    for row in rows {
        let filename: String = row.get("filename");
        images.push(filename);
    }

    let count_query = format!("SELECT COUNT(*) FROM images {}", where_clause);
    let total_res = sqlx::query(&count_query).fetch_one(&state.db).await;
    let count: i64 = match total_res {
        Ok(row) => row.get(0),
        Err(_) => 0,
    };

    let has_more = (offset + limit) < count;

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

   let _row_res = sqlx::query("SELECT filename, thumbnail_filename FROM images WHERE thumbnail_filename = ? LIMIT 1")
    .bind(&filename)
        .fetch_optional(&state.db)
        .await;

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
    let master_password = &state.master_password;

    if &req.password != master_password {
        return (StatusCode::UNAUTHORIZED, "Incorrect delete password").into_response();
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