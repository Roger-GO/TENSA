"""The models ANDES ships and its documentation of one of them."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SupportedModels(BaseModel):
    """Every model ANDES ships, grouped as ANDES groups them."""

    groups: dict[str, list[str]] = Field(
        ...,
        description=(
            "The ANDES model class names, keyed by the group ANDES puts each in "
            "(``Bus`` under ``ACNode``, ``GENROU`` under ``SynGen``), groups and "
            "models in ANDES's own order. A name here is what ``model`` takes on "
            "``GET /sessions/{id}/models/{model}/doc``. It is not the list of "
            "what the element routes build: those take only the models "
            "``GET /topology/schema`` lists."
        ),
    )


class ModelDoc(BaseModel):
    """ANDES's own documentation of one model."""

    model: str = Field(
        ...,
        description="The ANDES model class name the documentation is for.",
    )
    doc: str = Field(
        ...,
        description=(
            "The text ANDES prints for the model (``andes doc <model>``), "
            "verbatim: plain text with tables 78 columns wide of its "
            "parameters, variables and equations, to be read in a fixed-width "
            "font."
        ),
    )
