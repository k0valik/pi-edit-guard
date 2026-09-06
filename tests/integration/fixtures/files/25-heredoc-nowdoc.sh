#!/bin/bash
# Heredoc and Nowdoc Edge Cases
# This file tests various heredoc/nowdoc syntax patterns
# that can confuse the edit tool's matching logic.

# ─── Basic Heredoc ──────────────────────────────────────────────────────────

cat <<EOF
Basic heredoc with variable expansion
Variable: $VAR
Date: $(date)
EOF

# ─── Escaped Heredoc (No Expansion) ─────────────────────────────────────────

cat <<'EOF'
Escaped heredoc - no variable expansion
Variable: $VAR
Date: $(date)
EOF

# ─── Heredoc with Indentation ───────────────────────────────────────────────

cat <<-EOF
	Indented heredoc content
	Variables still expand: $VAR
	Commands still run: $(date)
EOF

# ─── Heredoc to Variable ────────────────────────────────────────────────────

VAR_CONTENT=$(cat <<EOF
Variable assignment heredoc
Line 1
Line 2
Line 3
EOF
)

# ─── Heredoc with Pipe ──────────────────────────────────────────────────────

cat <<EOF | grep "pattern"
Multiple lines
with pattern matching
and variable $VAR expansion
EOF

# ─── Nowdoc (Single-Quoted) ─────────────────────────────────────────────────

cat <<'EOF'
Nowdoc content
No $VAR expansion
No $(command) execution
Literal backslashes: \n \t \r
EOF

# ─── Heredoc with Stdin ─────────────────────────────────────────────────────

cat <<EOF | while read -r line; do
Processing line: $line
With variable: $VAR
EOF

# ─── Nested Heredoc ─────────────────────────────────────────────────────────

cat <<OUTER
Outer start
$(cat <<INNER
Inner content
Variable: $VAR
INNER
)
Outer end
Variable: $VAR
OUTER

# ─── Heredoc with Special Characters ───────────────────────────────────────

cat <<EOF
Special chars: ! @ # $ % ^ & * ( ) _ + - = { } [ ] | \ : ; " ' < > , . ? / ` ~
Unicode: café résumé naïve
Emoji: 🎉 🚀 ⚡ 🔥 💯
EOF

# ─── Heredoc with Leading Tabs ──────────────────────────────────────────────

cat <<-EOF
	Tab-indented line 1
	Tab-indented line 2 with $VAR
	Tab-indented line 3 with $(date)
EOF

# ─── Heredoc with Mixed Indentation ─────────────────────────────────────────

cat <<EOF
    Space-indented line 1
	Tab-indented line 2
        More spaces line 3
	Tab again line 4
EOF

# ─── Heredoc with Empty Lines ───────────────────────────────────────────────

cat <<EOF

Line after empty

Another empty line below

Final line
EOF

# ─── Heredoc with Comments ──────────────────────────────────────────────────

cat <<EOF
# This looks like a comment but is inside heredoc
// This also looks like a comment
/* And this looks like a block comment */
All are literal text in heredoc
EOF

# ─── Heredoc with Backslashes ───────────────────────────────────────────────

cat <<EOF
Backslash: \\
Newline: \n
Tab: \t
Carriage return: \r
Bell: \a
Backspace: \b
Form feed: \f
Vertical tab: \v
Null: \0
EOF

# ─── Heredoc with Quoted Patterns ──────────────────────────────────────────

cat <<"EOF"
Double-quoted heredoc delimiter
No $VAR expansion
No $(command) execution
EOF

cat <<'EOF'
Single-quoted heredoc delimiter
Same as above
EOF

# ─── Heredoc with Command Substitution ─────────────────────────────────────

cat <<EOF
Date: $(date +%Y-%m-%d)
User: $(whoami)
Pwd: $(pwd)
Files: $(ls -1 | wc -l)
EOF

# ─── Heredoc in Function ────────────────────────────────────────────────────

my_function() {
	cat <<EOF
Function heredoc
Argument 1: $1
Argument 2: $2
Global VAR: $VAR
EOF
}

# ─── Heredoc in Loop ────────────────────────────────────────────────────────

for i in 1 2 3; do
	cat <<EOF
Loop iteration $i
VAR: $VAR
Date: $(date)
EOF
done

# ─── Heredoc with Variable Assignment ──────────────────────────────────────

read -r VAR1 VAR2 VAR3 <<EOF
value1 value2 value3
EOF

# ─── Heredoc with Array ─────────────────────────────────────────────────────

mapfile -t ARRAY <<EOF
array element 1
array element 2
array element 3
EOF

# ─── Heredoc with Error Handling ────────────────────────────────────────────

cat <<EOF > output.txt || echo "Write failed"
This content goes to output.txt
With variable: $VAR
EOF

# ─── Heredoc with Append ────────────────────────────────────────────────────

cat <<EOF >> output.txt
Appended content
With $VAR expansion
EOF

# ─── Heredoc with Process Substitution ─────────────────────────────────────

cat <(cat <<EOF
Process substitution heredoc
Variable: $VAR
EOF
)

# ─── End of File ────────────────────────────────────────────────────────────

echo "End of heredoc-nowdoc.sh"
