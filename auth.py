import os
import uuid
from functools import wraps
from typing import Optional
from flask import request, jsonify, g
from clerk_backend_api import Clerk
from clerk_backend_api.security.types import AuthenticateRequestOptions

# Initialize Clerk SDK
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY) if CLERK_SECRET_KEY else None


def get_client_ip():
    """Get client IP, respecting X-Forwarded-For for reverse proxies."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _verify_session_token() -> Optional[str]:
    """Verify the current request's Clerk session token and return its user_id.

    Uses clerk_backend_api's authenticate_request(), which checks the token's
    RS256 signature against Clerk's JWKS (and expiry/issued-at) — unlike a
    bare jwt.decode(verify_signature=False), this cannot be fooled by a
    forged token carrying someone else's user_id. Returns None if the
    request has no valid, signed session token.
    """
    if not clerk_client:
        return None

    request_state = clerk_client.authenticate_request(
        request,
        AuthenticateRequestOptions(secret_key=CLERK_SECRET_KEY),
    )
    if not request_state.is_signed_in or not request_state.payload:
        return None
    return request_state.payload.get("sub")


def require_auth(f):
    """
    Middleware to protect Flask routes.
    Verifies the Clerk session token's signature via Clerk's JWKS.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not clerk_client:
            return jsonify({"error": "Clerk Auth is not configured on server"}), 500

        try:
            user_id = _verify_session_token()
        except Exception as e:
            print(f"[Auth Error] {e}")
            user_id = None

        if not user_id:
            return jsonify({"error": "Unauthorized"}), 401

        g.user_id = user_id
        return f(*args, **kwargs)
    return decorated


def optional_auth(f):
    """Allows both authenticated (Clerk JWT) and anonymous (cookie) users.

    Sets on flask.g:
      - g.user_id   (str | None)  — Clerk user ID if authenticated
      - g.guest_id  (str | None)  — anon_token UUID if guest
      - g.is_guest  (bool)        — True if no valid JWT
      - g.is_new_guest (bool)     — True if a new anon_token was just generated
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        g.user_id = None
        g.guest_id = None
        g.is_guest = True
        g.is_new_guest = False

        try:
            user_id = _verify_session_token()
        except Exception as e:
            print(f"[OptionalAuth] token verification failed, falling through to guest: {e}")
            user_id = None

        if user_id:
            g.user_id = user_id
            g.is_guest = False

        # Guest mode: use anon_token cookie
        if g.is_guest:
            anon_token = request.cookies.get("anon_token")
            if anon_token:
                g.guest_id = anon_token
            else:
                g.guest_id = str(uuid.uuid4())
                g.is_new_guest = True

        return f(*args, **kwargs)
    return decorated

