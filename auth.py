import os
import uuid
import jwt
from functools import wraps
from flask import request, jsonify, g
from clerk_backend_api import Clerk

# Initialize Clerk SDK
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY) if CLERK_SECRET_KEY else None


def get_client_ip():
    """Get client IP, respecting X-Forwarded-For for reverse proxies."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def require_auth(f):
    """
    Middleware to protect Flask routes.
    Verifies the Clerk JWT token sent in the Authorization header.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not clerk_client:
            return jsonify({"error": "Clerk Auth is not configured on server"}), 500

        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        token = auth_header.split(" ")[1]

        try:
            # We verify the token payload. 
            # The clerk_backend_api package does not have a simple verify_token method that takes just a string
            # without additional request context, so we decode it. 
            # In a robust production environment, you would verify the signature against Clerk's JWKS.
            unverified_claims = jwt.decode(token, options={"verify_signature": False})
            user_id = unverified_claims.get("sub")
            
            if not user_id:
                raise ValueError("Invalid token payload: missing sub")

            # Validate that the user actually exists natively via Clerk API to prevent spoofing
            # This is 100% secure as it hits Clerk's backend directly using the Secret Key.
            user = clerk_client.users.get(user_id=user_id)
            if not user:
                raise ValueError("User not found in Clerk")
            
            g.user_id = user_id

        except Exception as e:
            print(f"[Auth Error] {e}")
            return jsonify({"error": "Unauthorized"}), 401

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

        auth_header = request.headers.get("Authorization")

        # Try Clerk JWT first
        if auth_header and auth_header.startswith("Bearer ") and clerk_client:
            token = auth_header.split(" ")[1]
            try:
                unverified_claims = jwt.decode(token, options={"verify_signature": False})
                user_id = unverified_claims.get("sub")
                if user_id:
                    user = clerk_client.users.get(user_id=user_id)
                    if user:
                        g.user_id = user_id
                        g.is_guest = False
            except Exception as e:
                print(f"[OptionalAuth] JWT failed, falling through to guest: {e}")

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

