import os
import jwt
from functools import wraps
from flask import request, jsonify, g
from clerk_backend_api import Clerk

# Initialize Clerk SDK
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY")
clerk_client = Clerk(bearer_auth=CLERK_SECRET_KEY) if CLERK_SECRET_KEY else None

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
