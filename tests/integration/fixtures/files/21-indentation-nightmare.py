"""
Indentation Nightmare
This file has every possible indentation style mixed together.
Tests that the edit tool can handle files where every line
might have a different indentation approach.
"""

import os
import sys
import json
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from datetime import datetime

# Constants with 2-space indent
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30

@dataclass
class Config:
	# Class with tab indent
	name: str
	version: str
	debug: bool = False

	def __post_init__(self):
		pass

class BaseService:
	# Class with 4-space indent
	def __init__(self, config: Optional[Dict[str, Any]] = None):
		self.config = config or {}
		self.logger = self._setup_logger()

	def _setup_logger(self):
		# Method with 8-space indent
		import logging
		logger = logging.getLogger(self.__class__.__name__)
		logger.setLevel(logging.INFO)
		return logger

class UserService(BaseService):
	# Mixed: 4-space for class, but methods use tabs
	def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
		# Tab-indented method body
		query = "SELECT * FROM users WHERE id = %s"
		# Execute query
		result = self._execute(query, [user_id])
		if result:
			return dict(result)
		return None

	def create_user(self, data: Dict[str, Any]) -> Dict[str, Any]:
		# Another tab-indented method
		query = "INSERT INTO users (name, email) VALUES (%s, %s) RETURNING *"
		result = self._execute(query, [data["name"], data["email"]])
		return dict(result[0])

	def _execute(self, query: str, params: List[Any]) -> List[Dict[str, Any]]:
		# Private method with tab indent
		raise NotImplementedError("Subclasses must implement _execute")

class PostgresService(UserService):
	# 4-space indent class
	def __init__(self, connection_string: str):
		# 8-space method
		super().__init__()
		self.connection_string = connection_string
		self.pool = None

	def _execute(self, query: str, params: List[Any]) -> List[Dict[str, Any]]:
		# 8-space with mixed tabs inside
		import psycopg2
		conn = psycopg2.connect(self.connection_string)
		try:
			with conn.cursor() as cur:
				cur.execute(query, params)
				if query.strip().upper().startswith("SELECT"):
					return [dict(zip([desc[0] for desc in cur.description], row)) for row in cur.fetchall()]
				else:
					conn.commit()
					return []
		finally:
			conn.close()

def create_service(config: Dict[str, Any]) -> UserService:
	# 0-space indent function
	if config.get("type") == "postgres":
		return PostgresService(config["connection_string"])
	raise ValueError(f"Unknown service type: {config.get('type')}")

# 2-space indent section
## Configuration loading
def load_config(path: str) -> Dict[str, Any]:
	with open(path) as f:
		return json.load(f)

# 0-space indent
if __name__ == "__main__":
	config = load_config("config.json")
	service = create_service(config)
	user = service.get_user("123")
	print(user)
