from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .config import get_settings
from .errors import install_error_handlers
from .limits import limiter
from .routers import activities, admin, auth, checkins, journal


settings = get_settings()
app = FastAPI(title="Mindful API", description="Private wellbeing data API for Mindful.", version="1.0.0", docs_url="/docs", redoc_url="/redoc", openapi_url="/openapi.json")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
if settings.app_env.lower() == "production":
    app.add_middleware(HTTPSRedirectMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.host_names)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-CSRF-Token"])


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request.state.request_id = str(uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=(), payment=()"
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


install_error_handlers(app)
prefix = settings.api_prefix
for route_module in (auth, checkins, journal, activities, admin):
    app.include_router(route_module.router, prefix=prefix)


@app.get("/health", tags=["Operations"])
def health():
    return {"status": "ok", "service": "mindful-api"}
