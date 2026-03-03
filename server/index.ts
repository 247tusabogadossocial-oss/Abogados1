import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import cors, { type CorsOptions } from "cors";
import { setupAuth } from "./auth";


const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// 1) JSON + rawBody (útil para webhooks)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, "");
const isLocalOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

const configuredOrigins = [
  process.env.FRONTEND_URL,
  process.env.RENDER_EXTERNAL_URL,
  ...(process.env.CORS_ORIGINS ?? "").split(","),
]
  .map((value) => normalizeOrigin(String(value ?? "")))
  .filter(Boolean);

const allowedOrigins = new Set<string>([
  normalizeOrigin("http://localhost:5173"),
  normalizeOrigin("http://127.0.0.1:5173"),
  ...configuredOrigins,
]);

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return callback(null, true);
    if (process.env.NODE_ENV !== "production" && isLocalOrigin(normalized)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.set("trust proxy", 1); // importante en Render (proxy HTTPS)

app.use(cors(corsOptions));

// Fuerza respuesta a preflight en todas las rutas
app.options(/.*/, cors(corsOptions));




// 3) URL Encoded (forms)
app.use(express.urlencoded({ extended: false }));

// 4) Auth (sessions + passport)
setupAuth(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Logger de API
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

const originalResJson = res.json.bind(res);

res.json = (body: any) => {
  // si aquí estás leyendo/modificando body, hazlo antes
  return originalResJson(body);
};


  res.on("finish", () => {
    const duration = Date.now() - start;
    const isWebhookPath =
      path === "/retell-webhook" ||
      path === "/webhook" ||
      path === "/api/retell-webhook" ||
      path === "/api/webhook";
    if (path.startsWith("/api") || isWebhookPath) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Manejador de errores (después de rutas)
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  // Vite en dev / Static en prod
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);

  // En Windows, mejor escuchar en 127.0.0.1 en desarrollo
  const host =
    process.env.HOST ||
    (process.platform === "win32" ? "127.0.0.1" : "0.0.0.0");

  httpServer.listen(port, host, () => {
    log(`serving on http://${host}:${port}`);
  });
})();

