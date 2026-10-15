import express, { Router, type ErrorRequestHandler, type Request, type Response, type Router as ExpressRouter } from 'express';
import { HealthSchema, type Health } from '@wedding/shared/api';
import { DEVELOPMENT_ORIGIN, HELPER_HOST, HELPER_PORT, HELPER_VERSION, type HelperConfig } from './config.js';

const ALLOWED_METHODS: Record<string, true> = { GET: true, POST: true };
const ALLOWED_HEADERS: Record<string, true> = { authorization: true, 'content-type': true };
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError('AppError status must be an HTTP error status.');
    }
  }
}

export function createApp(
  config: HelperConfig,
  dependencies: Health['dependencies'],
  router?: ExpressRouter,
): express.Express {
  const app = express();
  const expectedHost = `${HELPER_HOST}:${HELPER_PORT}`;
  const allowedDevOrigin = config.devOrigin === DEVELOPMENT_ORIGIN ? DEVELOPMENT_ORIGIN : null;

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((request, response, next) => {
    if (request.headers.host !== expectedHost) {
      response.status(403).json({ error: { code: 'INVALID_HOST', message: 'Yêu cầu không được gửi tới địa chỉ helper hợp lệ.' } });
      return;
    }

    const isApiRequest = request.path === '/api' || request.path.startsWith('/api/');
    if (!isApiRequest) {
      next();
      return;
    }

    const origin = request.get('origin');
    if (request.method === 'OPTIONS') {
      handlePreflight(request, response, origin, allowedDevOrigin);
      return;
    }

    if (origin) {
      if (!isAllowedOrigin(origin, allowedDevOrigin)) {
        response.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Nguồn gửi yêu cầu không được cho phép.' } });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      appendVaryOrigin(response);
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  const healthRouter = Router();
  healthRouter.get('/health', (_request, response) => {
    response.json(HealthSchema.parse({
      ready: Object.values(dependencies).every(dependency => dependency.available),
      dependencies,
      version: HELPER_VERSION,
    }));
  });
  app.use('/api', healthRouter);
  if (router) app.use('/api', router);

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy API được yêu cầu.' } });
  });
  app.use(safeErrorHandler);
  return app;
}

export const safeErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof AppError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Nội dung JSON không hợp lệ.' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Nội dung yêu cầu vượt quá giới hạn cho phép.' } });
      return;
    }
  }

  console.error(error);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi nội bộ.' } });
};

function isAllowedOrigin(origin: string, devOrigin: string | null): boolean {
  return EXTENSION_ORIGIN.test(origin) || (devOrigin !== null && origin === devOrigin);
}

function handlePreflight(
  request: Request,
  response: Response,
  origin: string | undefined,
  devOrigin: string | null,
): void {
  if (!origin || !isAllowedOrigin(origin, devOrigin)) {
    response.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Nguồn gửi yêu cầu không được cho phép.' } });
    return;
  }

  const requestedMethod = request.get('access-control-request-method')?.toUpperCase();
  if (!requestedMethod || !Object.hasOwn(ALLOWED_METHODS, requestedMethod)) {
    response.status(403).json({ error: { code: 'INVALID_PREFLIGHT', message: 'Phương thức CORS không được cho phép.' } });
    return;
  }

  const requestedHeaders = (request.get('access-control-request-headers') ?? '')
    .split(',')
    .map(header => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some(header => !Object.hasOwn(ALLOWED_HEADERS, header))) {
    response.status(403).json({ error: { code: 'INVALID_PREFLIGHT', message: 'Header CORS không được cho phép.' } });
    return;
  }

  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
  appendVaryOrigin(response);
  response.status(204).end();
}

function appendVaryOrigin(response: Response): void {
  const vary = response.getHeader('Vary');
  response.setHeader('Vary', vary ? `${vary}, Origin` : 'Origin');
}
