import os
import stripe
from flask import Blueprint, request, jsonify

from database import db, User
from auth import require_auth

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")

payments_bp = Blueprint('payments', __name__)

@payments_bp.route("/api/create-checkout-session", methods=["POST"])
@require_auth
def create_checkout_session():
    # Note: Ensure this route is protected with @require_auth in server.py!
    # Because endpoints in Blueprint don't have global decorators automatically here
    # We will assume `g.user_id` is set by the calling wrapper or we expect it in JSON
    from flask import g
    user_id = getattr(g, 'user_id', None)
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    try:
        # Robust URL construction to prevent Stripe "Not a valid URL" errors
        raw_url = os.getenv("FRONTEND_URL")
        if not raw_url or len(raw_url.strip()) == 0:
            base_url = "http://localhost:5173"
        else:
            base_url = raw_url.strip().rstrip("/")
            if not base_url.startswith("http"):
                # Default to https for production domains if protocol is missing
                base_url = f"https://{base_url}"

        print(f"[Stripe] Creating session with base_url: {base_url}")

        # Create a new Checkout Session for the PRO plan
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[
                {
                    'price': os.getenv("STRIPE_PRO_PRICE_ID", "price_12345"),
                    'quantity': 1,
                },
            ],
            mode='subscription',
            # HashRouter uses /#/ — params before the hash are visible to the server
            success_url=f"{base_url}/?success=true#/",
            cancel_url=f"{base_url}/?canceled=true#/",
            metadata={
                "user_id": user_id
            }
        )
        return jsonify({"url": checkout_session.url})
    except Exception as e:
        return jsonify(error=str(e)), 500


@payments_bp.route("/api/billing-portal", methods=["POST"])
@require_auth
def billing_portal():
    """Create a Stripe Customer Portal session for subscription management."""
    from flask import g
    user_id = getattr(g, 'user_id', None)
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    if not user.stripe_customer_id:
        return jsonify({"error": "No active subscription found. Please upgrade to PRO first."}), 400

    try:
        raw_url = os.getenv("FRONTEND_URL", "http://localhost:5173").strip().rstrip("/")
        if not raw_url.startswith("http"):
            raw_url = f"https://{raw_url}"

        portal_session = stripe.billing_portal.Session.create(
            customer=user.stripe_customer_id,
            return_url=f"{raw_url}/profile",
        )
        return jsonify({"url": portal_session.url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@payments_bp.route("/api/webhook/stripe", methods=["POST"])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, WEBHOOK_SECRET
        )
    except ValueError:
        return "Invalid payload", 400
    except stripe.error.SignatureVerificationError:
        return "Invalid signature", 400

    if event['type'] == 'checkout.session.completed':
        session = event['data']['object']
        user_id = session.get("metadata", {}).get("user_id")

        if user_id:
            user = User.query.get(user_id)
            if user:
                user.plan = "pro"
                # Save Stripe customer ID for future billing portal access
                if session.get("customer"):
                    user.stripe_customer_id = session.get("customer")
                db.session.commit()
                print(f"[Stripe] Upgraded user {user_id} to PRO, customer={user.stripe_customer_id}")

    elif event['type'] == 'customer.subscription.deleted':
        sub = event['data']['object']
        customer_id = sub.get("customer")
        if customer_id:
            user = User.query.filter_by(stripe_customer_id=customer_id).first()
            if user:
                user.plan = "free"
                db.session.commit()
                print(f"[Stripe] Downgraded user {user.user_id} to FREE (subscription cancelled)")

    return jsonify(success=True)
