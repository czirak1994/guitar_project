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
        # Create a new Checkout Session for the PRO plan
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[
                {
                    # Provide the exact Price ID (e.g. pr_1234) of the product you have created
                    'price': os.getenv("STRIPE_PRO_PRICE_ID", "price_12345"),
                    'quantity': 1,
                },
            ],
            mode='subscription',
            success_url=os.getenv("FRONTEND_URL", "http://localhost:5173") + "/?success=true",
            cancel_url=os.getenv("FRONTEND_URL", "http://localhost:5173") + "/?canceled=true",
            metadata={
                "user_id": user_id
            }
        )
        return jsonify({"url": checkout_session.url})
    except Exception as e:
        return jsonify(error=str(e)), 500


@payments_bp.route("/api/webhook/stripe", methods=["POST"])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, WEBHOOK_SECRET
        )
    except ValueError as e:
        # Invalid payload
        return "Invalid payload", 400
    except stripe.error.SignatureVerificationError as e:
        # Invalid signature
        return "Invalid signature", 400

    # Handle the event
    if event['type'] == 'checkout.session.completed':
        session = event['data']['object']
        
        # Fulfill the purchase...
        user_id = session.get("metadata", {}).get("user_id")
        
        if user_id:
            user = User.query.get(user_id)
            if user:
                user.plan = "pro"
                db.session.commit()
                print(f"[Stripe] Upgraded user {user_id} to PRO")

    elif event['type'] == 'customer.subscription.deleted':
        # Handled when subscription is cancelled
        sub = event['data']['object']
        # We need to map customer back to user, usually by querying customer ID
        pass # Optional for simple MVP

    return jsonify(success=True)
