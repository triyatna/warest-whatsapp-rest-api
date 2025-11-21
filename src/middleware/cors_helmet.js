import cors from 'cors';
import helmet from 'helmet';
import { config } from '../config.js';

export function securityMiddleware(app) {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));
  const origins = config.allowedOrigins;
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS not allowed'), false);
    },
    credentials: true
  }));
}
