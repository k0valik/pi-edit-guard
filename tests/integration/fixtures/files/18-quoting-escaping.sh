#!/bin/bash
# Quoting and Escaping Edge Cases
# This script contains various shell quoting and escaping patterns
# that can confuse the edit tool's matching logic.

# ─── Single Quotes ───────────────────────────────────────────────────────────

SINGLE_QUOTE='single quoted string with $variable and $(command)'
SINGLE_QUOTE_EMPTY=''
SINGLE_QUOTE_SPACE=' '

# ─── Double Quotes ───────────────────────────────────────────────────────────

DOUBLE_QUOTE="double quoted string with $variable and $(command)"
DOUBLE_QUOTE_ESCAPE="string with \"escaped quotes\" and \$escaped dollar"
DOUBLE_QUOTE_NEWLINE="line1
line2"
DOUBLE_QUOTE_TAB="col1	col2"

# ─── Mixed Quotes ────────────────────────────────────────────────────────────

MIXED1='single with "double" inside'
MIXED2="double with 'single' inside"
MIXED3='single with \'escaped single\' inside'
MIXED4="double with \"escaped double\" inside"

# ─── Command Substitution ────────────────────────────────────────────────────

CMD_SUB1=$(echo "hello world")
CMD_SUB2=`echo "hello world"`
CMD_SUB3=$(cat <<'EOF'
heredoc content
with multiple lines
EOF
)
CMD_SUB4=$(cat <<EOF
heredoc with expansion: $variable
EOF
)

# ─── Arithmetic Expansion ────────────────────────────────────────────────────

ARITH1=$(( 1 + 2 ))
ARITH2=$(( 2 * 3 ))
ARITH3=$(( 10 / 3 ))
ARITH4=$(( 10 % 3 ))
ARITH5=$(( 1 << 3 ))
ARITH6=$(( 16 >> 2 ))
ARITH7=$(( 5 & 3 ))
ARITH8=$(( 5 | 3 ))
ARITH9=$(( 5 ^ 3 ))
ARITH10=$(( ~5 ))
ARITH11=$(( 1 < 2 ))
ARITH12=$(( 3 >= 2 ))

# ─── Parameter Expansion ─────────────────────────────────────────────────────

PARAM1=${VAR:-default}
PARAM2=${VAR:=default}
PARAM3=${VAR:?error message}
PARAM4=${VAR:+alternative}
PARAM5=${VAR#prefix}
PARAM6=${VAR##prefix}
PARAM7=${VAR%suffix}
PARAM8=${VAR%%suffix}
PARAM9=${VAR:offset:length}
PARAM10=${!PREFIX*}

# ─── Brace Expansion ─────────────────────────────────────────────────────────

BRACE1={a,b,c}
BRACE2={1..5}
BRACE3={a..z}
BRACE4=file{1..3}.txt

# ─── Tilde Expansion ─────────────────────────────────────────────────────────

TILDE1=~
TILDE2=~
TILDE3=~user

# ─── Process Substitution ────────────────────────────────────────────────────

PROC_SUB1=$(diff <(echo "file1") <(echo "file2"))
PROC_SUB2=( $(cat <(echo "a") <(echo "b")) )

# ─── Redirections ────────────────────────────────────────────────────────────

REDIR1=output.txt
REDIR2=error.txt
REDIR3=all.txt
REDIR4=< input.txt
REDIR5=<<EOF
heredoc input
EOF
REDIR6=< <(echo "process substitution input")

# ─── Pipes and Operators ─────────────────────────────────────────────────────

PIPE1="cmd1 | cmd2"
PIPE2="cmd1 | cmd2 | cmd3"
AND1="cmd1 && cmd2"
OR1="cmd1 || cmd2"
SEMI1="cmd1; cmd2"
BG1="cmd1 &"

# ─── Complex Command ─────────────────────────────────────────────────────────

COMPLEX=$(find . -name "*.js" -exec grep -l "TODO" {} \; | xargs sed -i 's/TODO/DONE/g')

# ─── Array Declarations ──────────────────────────────────────────────────────

ARR1=(one two three)
ARR2=([0]="first" [1]="second" [2]="third")
ARR3=($(echo "a b c"))
ARR4=("file1" "file with spaces" "file3")

# ─── Associative Arrays (bash 4+) ────────────────────────────────────────────

declare -A MAP1=(
	[key1]="value1"
	[key2]="value2"
	[key3]="value3"
)

# ─── Functions ───────────────────────────────────────────────────────────────

function func1() {
	echo "function with standard syntax"
}

func2() {
	echo "function without keyword"
}

func3() {
	local var="local variable"
	readonly CONSTANT="constant"
	export EXPORTED="exported"
}

# ─── Conditional Expressions ─────────────────────────────────────────────────

if [[ -f "file.txt" ]]; then
	echo "file exists"
elif [[ -d "dir" ]]; then
	echo "directory exists"
else
	echo "neither"
fi

if [ "$VAR" = "value" ]; then
	echo "string comparison"
fi

if (( 5 > 3 )); then
	echo "arithmetic comparison"
fi

# ─── Case Statements ─────────────────────────────────────────────────────────

case "$VAR" in
	pattern1)
		echo "matched pattern1"
		;;
	pattern2)
		echo "matched pattern2"
		;;
	*)
		echo "default"
		;;
esac

# ─── Loops ───────────────────────────────────────────────────────────────────

for i in 1 2 3; do
	echo "item: $i"
done

for i in {1..5}; do
	echo "item: $i"
done

for file in *.txt; do
	echo "file: $file"
done

while read -r line; do
	echo "line: $line"
done < input.txt

until [[ "$COUNT" -gt 5 ]]; do
	echo "count: $COUNT"
	((COUNT++))
done

# ─── Select ──────────────────────────────────────────────────────────────────

PS3="Choose: "
select opt in "option1" "option2" "option3"; do
	echo "selected: $opt"
	break
done
