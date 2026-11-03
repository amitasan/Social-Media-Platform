# ✦ Sparkle — a social media app

Express + built-in Node SQLite (`node:sqlite`, needs Node 22.13+) backend, dependency-free single-page frontend.

## Run
```
npm install
npm start          # http://localhost:3000   (PORT=… to change)
```
Data lives in `social.db` and `uploads/` (override with `DATA_DIR`). Set `JWT_SECRET` in production; otherwise one is generated and saved to `.jwt-secret`.

## Features
**Core** — sign up / log in (bcrypt + JWT) · editable profiles (name, bio, avatar) · text posts with image/video upload (JPG/PNG/GIF/WebP/MP4/WebM/MOV, 50 MB) · likes · comments · post tagging (`#hashtags` in text, a tag field, and `@mentions`) · delete your own posts/comments.
**Optional** — follow/unfollow with a "Following" feed · notifications (likes, comments, follows, mentions) with unread badge · Explore page with trending tags and time-decayed trending posts · tag pages · people search · suggested users.

## API (all under `/api`)
`POST auth/register|login` · `GET|PUT me` · `GET users/search?q=` · `GET users/suggestions` · `GET users/:u` · `GET users/:u/posts` · `POST users/:u/follow` · `GET feed?scope=all|following&tag=&before=` · `POST posts` (multipart: text, tags, media) · `GET|DELETE posts/:id` · `POST posts/:id/like` · `GET|POST posts/:id/comments` · `DELETE comments/:id` · `GET trending` · `GET notifications` · `GET notifications/count` · `POST notifications/read`

## Layout
`server.js` API + DB schema · `public/` index.html, style.css, app.js (hash-routed SPA, responsive, dark mode)

## Production notes
Add rate limiting and HTTPS, move uploads to object storage, and consider server-side media transcoding/virus scanning.
