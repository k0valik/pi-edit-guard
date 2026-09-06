// Multiline String Edge Cases
// Tests edit tool behavior with template literals, concatenated strings,
// and multiline string constructs that span many lines.

const templateLiteral1 = `Hello ${name},
your order #${orderId} has been confirmed.
Total: $${total.toFixed(2)}
Thank you for shopping with us!`;

const templateLiteral2 = `Dear ${user.name},

We received your request regarding "${request.subject}".

Here are the details:
- ID: ${request.id}
- Status: ${request.status}
- Created: ${new Date(request.createdAt).toLocaleString()}

Please review and let us know if you have any questions.

Best regards,
The Support Team`;

const templateLiteral3 = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${pageTitle}</title>
	<style>
		body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
		.header { background: ${colors.primary}; color: white; padding: 20px; }
		.content { padding: 20px; }
		.footer { background: #f5f5f5; padding: 10px; text-align: center; }
	</style>
</head>
<body>
	<div class="header">
		<h1>${heading}</h1>
		<p>${subtitle}</p>
	</div>
	<div class="content">
		${bodyContent}
	</div>
	<div class="footer">
		<p>© ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
	</div>
</body>
</html>`;

const concatenated1 =
	"SELECT " +
	"u.id, " +
	"u.name, " +
	"u.email, " +
	"o.id AS order_id, " +
	"o.total " +
	"FROM users u " +
	"JOIN orders o ON o.user_id = u.id " +
	"WHERE u.id = ? " +
	"AND o.status = 'completed' " +
	"ORDER BY o.created_at DESC";

const concatenated2 = "line1\n" + "line2\n" + "line3\n" + "line4\n";

const arrayMultiline = [
	"item1",
	"item2",
	"item3",
	"item4",
	"item5",
];

const objectMultiline = {
	key1: "value1",
	key2: "value2",
	key3: "value3",
	key4: "value4",
	key5: "value5",
};

const functionMultiline = function (
	arg1,
	arg2,
	arg3,
	arg4,
	arg5,
) {
	const result = arg1 + arg2 + arg3 + arg4 + arg5;
	return result;
};

const arrowMultiline = (
	arg1,
	arg2,
	arg3,
	arg4,
	arg5,
) => {
	const result = arg1 + arg2 + arg3 + arg4 + arg5;
	return result;
};

const taggedTemplate1 = css`
	.container {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 24px;
	}
	
	.header {
		font-size: 24px;
		font-weight: bold;
		color: ${colors.text};
	}
	
	.body {
		font-size: 16px;
		line-height: 1.5;
		color: ${colors.textSecondary};
	}
`;

const taggedTemplate2 = sql`
	SELECT
		u.id,
		u.name,
		COUNT(o.id) AS order_count,
		SUM(o.total) AS total_spent
	FROM users u
	LEFT JOIN orders o ON o.user_id = u.id
	WHERE u.created_at >= ${startDate}
	AND u.status = '${status}'
	GROUP BY u.id, u.name
	HAVING COUNT(o.id) > ${minOrders}
	ORDER BY total_spent DESC
	LIMIT ${limit}
`;

const jsonStringify = JSON.stringify(
	{
		users: [
			{ id: 1, name: "Alice", email: "alice@example.com", roles: ["admin", "user"] },
			{ id: 2, name: "Bob", email: "bob@example.com", roles: ["user"] },
			{ id: 3, name: "Charlie", email: "charlie@example.com", roles: ["user", "moderator"] },
		],
		metadata: {
			total: 3,
			page: 1,
			perPage: 10,
			totalPages: 1,
		},
	},
	null,
	2,
);

const regexMultiline = /^import\s+(?:\{([^}]+)\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"];?$/gm;

const commentMultiline = `
 * This is a multiline comment
 * that spans many lines
 * and contains important documentation
 * about the function below.
 * 
 * @param {string} arg1 - First argument
 * @param {number} arg2 - Second argument
 * @returns {Promise<Result>} A promise that resolves to a Result
 * @throws {Error} If validation fails
 * @example
 * const result = await processData("hello", 42);
 * console.log(result.success);
 */

export { templateLiteral1, templateLiteral2, templateLiteral3, concatenated1, concatenated2, arrayMultiline, objectMultiline, functionMultiline, arrowMultiline, taggedTemplate1, taggedTemplate2, jsonStringify, regexMultiline, commentMultiline };
