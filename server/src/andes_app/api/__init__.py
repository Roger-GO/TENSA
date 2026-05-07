"""HTTP / WebSocket API surface.

``app.py`` builds the FastAPI application. ``auth.py`` provides the per-route
dependency that validates the ``X-Andes-Token`` header against the active
token. ``schemas.py`` defines the Pydantic v2 request / response models.
``routes/`` contains one router per resource family.
"""
