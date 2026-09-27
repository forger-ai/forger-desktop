from fastapi import APIRouter

router = APIRouter(prefix="/api/desk", tags=["desk"])


@router.get("")
def local_desk() -> dict[str, str]:
    return {"name": "My local desk", "storage": "local"}
