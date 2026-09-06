#!/bin/bash
# Comment and String Edge Cases
# This file has comments that look like code, strings that look like comments,
# and other confusing constructs that can trick fuzzy matching.

# ─── Comments That Look Like Code ───────────────────────────────────────────

# function calculateTotal(items) {
# 	return items.reduce((sum, item) => sum + item.price, 0);
# }

# const TAX_RATE = 0.08;
# const DISCOUNT_THRESHOLD = 100;

# class ShoppingCart {
# 	constructor() {
# 		this.items = [];
# 		this.total = 0;
# 	}
# 	addItem(item) {
# 		this.items.push(item);
# 		this.total += item.price;
# 	}
# }

# ─── Strings That Look Like Comments ────────────────────────────────────────

MSG1="# This looks like a comment but is actually a string"
MSG2="// This also looks like a comment"
MSG3="/* And this looks like a block comment */"

# ─── SQL in Strings ─────────────────────────────────────────────────────────

SQL1="SELECT * FROM users WHERE id = 1"
SQL2="UPDATE users SET name = 'John' WHERE id = 1"
SQL3="DELETE FROM sessions WHERE expired_at < NOW()"
SQL4="INSERT INTO logs (message, level) VALUES ('info', 'test')"

# ─── Code in Strings ────────────────────────────────────────────────────────

CODE_SNIPPET='if (x > 0) { return x * 2; } else { return 0; }'
JS_OBJECT='{ "name": "test", "value": 123, "active": true }'
JSON_ARRAY='[{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]'

# ─── Shell Commands in Strings ──────────────────────────────────────────────

CMD1="git commit -m 'Initial commit'"
CMD2="npm install --save-dev typescript"
CMD3="docker build -t myapp ."
CMD4="kubectl apply -f deployment.yaml"

# ─── Regex in Strings ───────────────────────────────────────────────────────

REGEX1="^[a-zA-Z0-9]+$"
REGEX2="\\d{3}-\\d{2}-\\d{4}"
REGEX3="[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}"

# ─── Paths in Strings ───────────────────────────────────────────────────────

PATH1="/usr/local/bin/myapp"
PATH2="./src/components/Header.js"
PATH3="../config/settings.json"
PATH4="~/Documents/report.pdf"

# ─── HTML in Strings ────────────────────────────────────────────────────────

HTML1="<div class='container'>Hello</div>"
HTML2="<a href='/about'>About</a>"
HTML3="<img src='logo.png' alt='Logo' />"

# ─── URLs in Strings ────────────────────────────────────────────────────────

URL1="https://example.com/api/v1/users"
URL2="mailto:test@example.com"
URL3="ftp://files.example.com/resource.zip"
URL4="ssh://git@github.com:user/repo.git"

# ─── JSON in Strings ────────────────────────────────────────────────────────

JSON1='{"name":"test","value":123,"active":true}'
JSON2='[1,2,3,4,5]'
JSON3='null'
JSON4='{"nested":{"deep":{"value":"found"}}}'

# ─── Markdown in Strings ────────────────────────────────────────────────────

MD1="# Heading\n\nParagraph with **bold** and *italic*."
MD2="- Item 1\n- Item 2\n- Item 3"
MD3="| A | B |\n|---|---|\n| 1 | 2 |"

# ─── Code Blocks in Strings ─────────────────────────────────────────────────

CODE_BLOCK='```javascript\nconst x = 1;\nconsole.log(x);\n```'
CODE_FENCE='```\ncode here\n```'

# ─── Template Literals as Strings ───────────────────────────────────────────

TMPL1="Hello, ${name}!"
TMPL2="Total: $${total.toFixed(2)}"

# ─── Escaped Characters ─────────────────────────────────────────────────────

ESC1="Line with\ttab"
ESC2="Line with\nnewline"
ESC3="Quote: \"Hello\""
ESC4="Backslash: \\path\\to\\file"
ESC5="Dollar: \$100"

# ─── Multiline Strings ──────────────────────────────────────────────────────

cat <<'EOF' > /tmp/multiline.txt
This is a heredoc string
that spans multiple lines
and should not be confused
with actual code blocks.
EOF

# ─── Confusing Comments ─────────────────────────────────────────────────────

# TODO: Fix this function
# FIXME: This is broken
# NOTE: Important consideration
# HACK: Temporary workaround
# OPTIMIZE: Performance issue
# XXX: Needs review

# ─── More Confusing Patterns ────────────────────────────────────────────────

# if [[ -f "config.json" ]]; then
# 	echo "Config exists"
# fi

# for i in {1..10}; do
# 	echo "Item: $i"
# done

# while read -r line; do
# 	echo "$line"
# done < input.txt

# case "$1" in
# 	start)
# 		echo "Starting"
# 		;;
# 	stop)
# 		echo "Stopping"
# 		;;
# esac

# ─── End of File ────────────────────────────────────────────────────────────

echo "End of comment-strings-astray.sh"
