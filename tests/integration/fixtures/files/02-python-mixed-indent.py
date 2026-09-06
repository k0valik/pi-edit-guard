"""
Data processing module with intentionally mixed indentation.

This file mixes tabs and spaces to test indentation normalization.
Some functions use 4 spaces, others use tabs, and a few use 2 spaces.
This is a common real-world issue when multiple contributors
use different editor settings.
"""

import os
import sys
import json
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from datetime import datetime, timezone

# Constants with various indentation styles
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30
BASE_URL = "https://api.example.com/v1"

@dataclass
class User:
    """User model with mixed-style method indentation."""
    id: str
    name: str
    email: str
    created_at: datetime
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "created_at": self.created_at.isoformat(),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "User":
        """Create from dictionary."""
        return cls(
            id=data["id"],
            name=data["name"],
            email=data["email"],
            created_at=datetime.fromisoformat(data["created_at"]),
            metadata=data.get("metadata", {}),
        )


class DataProcessor:
    """Processes data with various indentation styles."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.cache: Dict[str, Any] = {}
        self.logger = self._setup_logger()

    def _setup_logger(self):
        """Setup logging."""
        import logging
        logger = logging.getLogger("data_processor")
        logger.setLevel(logging.INFO)
        if not logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
            )
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        return logger

    async def fetch_user(self, user_id: str) -> Optional[User]:
        """Fetch user by ID with retry logic."""
        for attempt in range(MAX_RETRIES):
            try:
                self.logger.info(f"Fetching user {user_id}, attempt {attempt + 1}")
                data = await self._make_request(f"/users/{user_id}")
                return User.from_dict(data)
            except Exception as e:
                self.logger.warning(f"Attempt {attempt + 1} failed: {e}")
                if attempt == MAX_RETRIES - 1:
                    raise
                await self._backoff(attempt)

    async def _make_request(self, path: str) -> Dict[str, Any]:
        """Make HTTP request."""
        import aiohttp
        url = f"{BASE_URL}{path}"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                response.raise_for_status()
                return await response.json()

    async def _backoff(self, attempt: int) -> None:
        """Exponential backoff."""
        import asyncio
        delay = (2 ** attempt) * 0.1
        await asyncio.sleep(delay)

    def process_batch(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a batch of items."""
        results = []
        for item in items:
            try:
                processed = self._process_item(item)
                results.append(processed)
            except Exception as e:
                self.logger.error(f"Failed to process item: {e}")
                results.append({"error": str(e)})
        return results

    def _process_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Process single item."""
        if not item:
            raise ValueError("Item cannot be empty")

        item_type = item.get("type")
        if item_type == "user":
            return self._process_user(item)
        elif item_type == "batch":
            return self._process_batch(item)
        else:
            raise ValueError(f"Unknown item type: {item_type}")

    def _process_user(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Process user data."""
        user = User.from_dict(data)
        return user.to_dict()

    def _process_batch(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Process batch data."""
        items = data.get("items", [])
        processed = self.process_batch(items)
        return {
            "batch_id": data.get("id"),
            "count": len(processed),
            "items": processed,
        }


def main():
    """Main entry point with mixed indentation."""
    processor = DataProcessor()

    # Sample data
    sample = {
        "type": "user",
        "id": "123",
        "name": "John Doe",
        "email": "john@example.com",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    import asyncio
    result = asyncio.run(processor.fetch_user("123"))
    print(result)


if __name__ == "__main__":
    main()
