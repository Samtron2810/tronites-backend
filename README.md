# mini-social-media Backend

This backend is an Express API server for the mini-social-media application. It provides authentication, user management, posts, comments, notifications, messages, and real-time socket updates.

## Tech stack

- Node.js
- Express 5
- MongoDB / Mongoose
- Socket.IO
- Cloudinary image upload support
- JWT cookie authentication
- dotenv for environment configuration

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in `backend/` with required values.
3. Start the server in development mode:
   ```bash
   npm run dev
   ```

## Production start

```bash
npm install --production
npm start
```

## Required environment variables

- `MONGO_URI` — MongoDB connection string
- `JWT_SECRET` — strong secret for signing JWT cookies
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `PORT` — optional; defaults to `5000`
- `NODE_ENV` — set to `production` in production
- `FRONTEND_ORIGINS` or `CORS_ORIGINS` — comma-separated allowed origins for CORS and Socket.IO.

### Example `.env`

```env
MONGO_URI=mongodb+srv://username:password@cluster0.mongodb.net/mini-social-media
JWT_SECRET=super-secret-value
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
PORT=5000
NODE_ENV=production
FRONTEND_ORIGINS=https://app.example.com,https://www.example.com
```

## Deployment notes

- If frontend and backend are deployed separately, set `FRONTEND_ORIGINS` to the frontend host(s).
- If the frontend is served from the same origin as the backend, use `/api` for client requests and no extra CORS origins are required.
- Socket.IO uses the same allowed origin list as the Express API.
- Ensure HTTPS in production if using cookies with `secure` and `sameSite='none'`.

## API base URL

The frontend uses `VITE_API_URL` at build time to point to this backend. If `VITE_API_URL` is not set, the frontend will default to `/api`.
