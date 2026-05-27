const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "https://tronites.vercel.app",
];

const getAllowedOrigins = () => {
  const env = process.env.FRONTEND_ORIGINS || process.env.CORS_ORIGINS;
  if (!env) return DEFAULT_ORIGINS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

export default getAllowedOrigins;
