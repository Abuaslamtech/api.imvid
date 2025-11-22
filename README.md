# Multi-Platform Video Downloader Backend

This project is a backend service for a multi-platform video downloader application. It provides an API to extract video information from various platforms like YouTube, Instagram, TikTok, and Facebook.

## Features

- Extracts video metadata (title, author, thumbnail, duration, etc.)
- Provides direct streamable and downloadable links
- Supports YouTube, Instagram, TikTok, and Facebook
- In-memory caching for faster responses

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/api.imvid.git
   ```
2. Install the dependencies:
   ```bash
   npm install
   ```
3. Download the `yt-dlp` binary from the [official website](https://github.com/yt-dlp/yt-dlp#installation) and place it in the root directory of the project.

## Usage

1. Start the server:
   ```bash
   npm start
   ```
2. The server will be running on `http://localhost:3000`.

## API Endpoints

### `GET /extract`

This endpoint extracts video information from a given URL.

**Query Parameters:**

- `url` (required): The URL of the video to extract information from.

**Example Request:**

```
http://localhost:3000/extract?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

**Example Response:**

```json
{
  "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
  "author": "RickAstleyVEVO",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "duration": 212,
  "platform": "youtube",
  "videoId": "dQw4w9WgXcQ",
  "streamUrl": "https://rr4---sn-a5mekn7l.googlevideo.com/...",
  "downloadUrl": "/download?vid=dQw4w9WgXcQ",
  "filesize": 48281859,
  "resolution": "1080p",
  "format": "mp4"
}
```
## Notes
-This documentation is a basic one and it will be updated in future
-The code contains a download endpoint that is not yet implemented
-For some social media platforms like Instagram and Facebook, you might need to provide cookies to bypass login restrictions. The application is configured to use cookies from Firefox by default. You can change this in the `index.js` file.
