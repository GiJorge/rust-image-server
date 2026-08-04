FROM ubuntu:24.04

WORKDIR /app

# 1. Copy FFmpeg into /usr/local/bin
COPY ffmpeg /usr/local/bin/ffmpeg

# 2. Ensure execution permissions are set INSIDE the container layer
RUN chmod +x /usr/local/bin/ffmpeg

# 3. Copy Rust app and static assets
COPY target/release/rust-image-server /app/rust-image-server
COPY static ./static

# 4. Storage directories
RUN mkdir -p /app/images /app/thumb /app/data

ENV DATABASE_URL="sqlite:///app/data/gallery.db?mode=rwc"
ENV RUST_LOG="info"

EXPOSE 3033

CMD ["/app/rust-image-server"]