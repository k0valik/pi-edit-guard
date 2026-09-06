# File with comments and strings that look like code
# Tests that the edit tool doesn't accidentally match inside comments or strings

"""
Module: feature_flags.py
Description: Feature flag management with toggle evaluation
"""

# Feature flag definitions
FEATURES = {
    # Authentication features
    "auth_v2": {
        "enabled": True,
        "description": "New authentication system",
        "rollout": 50,  # percentage
        "targets": ["beta_testers", "internal_users"],
        "conditions": {
            "min_version": "2.0.0",
            "require_mfa": True,
            "allowed_domains": ["example.com", "test.example.com"]
        }
    },
    # API features
    "api_rate_limiting": {
        "enabled": True,
        "description": "Rate limiting for API endpoints",
        "rollout": 100,
        "targets": ["all_users"],
        "conditions": {
            "max_requests": 100,
            "window_seconds": 60,
            "excluded_paths": ["/health", "/metrics"]
        }
    },
    # Experimental features
    "experimental_ui": {
        "enabled": False,
        "description": "New experimental UI components",
        "rollout": 0,
        "targets": [],
        "conditions": {
            "require_experiment": True,
            "experiment_id": "exp_ui_2024"
        }
    }
}

# Code that looks like configuration but is actually Python code
def evaluate_flag(flag_name, user_context):
    """
    Evaluate whether a feature flag is enabled for a given user.
    
    Args:
        flag_name: Name of the feature flag
        user_context: Dictionary with user attributes
        
    Returns:
        Boolean indicating if feature is enabled
    """
    flag = FEATURES.get(flag_name)
    if not flag:
        return False
    
    if not flag["enabled"]:
        return False
    
    # Check rollout percentage
    rollout = flag.get("rollout", 0)
    if rollout < 100:
        user_id_hash = hash(user_context.get("id", "")) % 100
        if user_id_hash >= rollout:
            return False
    
    # Check targets
    targets = flag.get("targets", [])
    if targets and "all_users" not in targets:
        user_groups = user_context.get("groups", [])
        if not any(group in targets for group in user_groups):
            return False
    
    return True


# SQL-like strings that should not be matched as SQL
SQL_QUERIES = {
    "get_user": """
        SELECT id, name, email, created_at
        FROM users
        WHERE id = %s AND deleted_at IS NULL
    """,
    "update_user": """
        UPDATE users
        SET name = %s, email = %s, updated_at = NOW()
        WHERE id = %s
    """,
    "list_permissions": """
        SELECT p.name, p.resource, p.action
        FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = %s
    """
}

# JSON-like configuration strings
DEFAULT_CONFIG = """{
    "app": {
        "name": "test-app",
        "version": "1.0.0",
        "debug": false
    },
    "database": {
        "host": "localhost",
        "port": 5432,
        "name": "app_db"
    }
}"""

# HTML-like template strings
EMAIL_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <title>Welcome</title>
</head>
<body>
    <h1>Welcome, {{name}}!</h1>
    <p>Your account has been created.</p>
</body>
</html>
"""

# Shell-like commands in strings
DEPLOY_COMMANDS = [
    "git pull origin main",
    "pnpm install --frozen-lockfile",
    "pnpm run build",
    "docker build -t app:latest .",
    "docker push registry.example.com/app:latest",
    "kubectl apply -f k8s/deployment.yaml"
]

# Code snippets in comments that look like real code
# def authenticate(token):
#     user = decode_token(token)
#     if not user:
#         raise AuthenticationError("Invalid token")
#     return user

# def authorize(user, resource, action):
#     permissions = get_permissions(user.roles)
#     return any(p.resource == resource and p.action == action for p in permissions)

# YAML-like configuration in comments
# config:
#   app:
#     name: myapp
#     env: production
#   database:
#     host: db.example.com
#     port: 5432

if __name__ == "__main__":
    # Test flag evaluation
    test_user = {"id": "user-123", "groups": ["beta_testers"]}
    print(evaluate_flag("auth_v2", test_user))
    print(evaluate_flag("experimental_ui", test_user))
