// Very Long Lines Test File
// This file contains extremely long lines to test fuzzy matching,
// line wrapping, and token estimation limits.

const veryLongString = "This is a very long string that contains many words and should exceed typical line lengths to test how the edit tool handles lines that are hundreds or thousands of characters long without any line breaks or truncation points that would normally help with fuzzy matching and context anchoring.";

const jsonLikeObject = {
  key1: "value1",
  key2: "value2",
  key3: "value3",
  key4: "value4",
  key5: "value5",
  key6: "value6",
  key7: "value7",
  key8: "value8",
  key9: "value9",
  key10: "value10",
};

const arrayOfStrings = [
  "string one that is moderately long but not extremely long",
  "string two that is moderately long but not extremely long",
  "string three that is moderately long but not extremely long",
  "string four that is moderately long but not extremely long",
  "string five that is moderately long but not extremely long",
];

const templateLiteral = `This is a template literal with a very long string that spans multiple conceptual lines but is actually one single line in the source code and contains interpolated values like ${veryLongString} and ${jsonLikeObject.key1} and ${arrayOfStrings[0]} all concatenated together into one massive line that should test the token limits and fuzzy matching boundaries of the edit tool.`;

const concatenatedString =
  "part1" +
  "part2" +
  "part3" +
  "part4" +
  "part5" +
  "part6" +
  "part7" +
  "part8" +
  "part9" +
  "part10" +
  "part11" +
  "part12" +
  "part13" +
  "part14" +
  "part15" +
  "part16" +
  "part17" +
  "part18" +
  "part19" +
  "part20";

const chainedMethodCalls = someObject
  .firstMethod({ arg1: "value1", arg2: "value2", arg3: "value3", arg4: "value4", arg5: "value5" })
  .secondMethod({ arg1: "value1", arg2: "value2", arg3: "value3", arg4: "value4", arg5: "value5" })
  .thirdMethod({ arg1: "value1", arg2: "value2", arg3: "value3", arg4: "value4", arg5: "value5" })
  .fourthMethod({ arg1: "value1", arg2: "value2", arg3: "value3", arg4: "value4", arg5: "value5" })
  .fifthMethod({ arg1: "value1", arg2: "value2", arg3: "value3", arg4: "value4", arg5: "value5" });

const sqlQuery = `SELECT users.id, users.name, users.email, orders.id AS order_id, orders.created_at, orders.total, products.id AS product_id, products.name AS product_name, categories.id AS category_id, categories.name AS category_name FROM users LEFT JOIN orders ON orders.user_id = users.id LEFT JOIN order_items ON order_items.order_id = orders.id LEFT JOIN products ON products.id = order_items.product_id LEFT JOIN categories ON categories.id = products.category_id WHERE users.created_at > '2024-01-01' AND orders.total > 100 AND categories.active = true ORDER BY orders.created_at DESC LIMIT 100 OFFSET 0`;

const pathOperations = path.join(__dirname, "..", "node_modules", ".cache", "temp", "build", "output", "dist", "assets", "images", "icons", "svg", "regular", "user", "profile", "avatar", "default", "placeholder", "image", "file", "name", "with", "many", "segments", "and", "nested", "directories", "that", "should", "test", "path", "handling", "in", "the", "edit", "tool");

const regexPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/g;

const urlString = "https://subdomain.example.com:8443/api/v2/users/12345/orders?include=items,products,categories&filter[status]=active&sort=-created_at&page[number]=1&page[size]=50&fields[users]=id,name,email&fields[orders]=id,total,status&fields[items]=id,quantity,price";

const base64Encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const hexString = "0xDEADBEEFCAFEBABE0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const binaryString = "01001000 01000101 01001100 01001100 01001111 00100000 01010111 01001111 01010010 01001100 01000100";

const multiLineComment = `
  This is a multi-line comment that contains a very long string
  spanning multiple lines in the source but conceptually one long
  block of text that should test how the edit tool handles comments
  with extensive content and internal structure that might be confused
  with actual code or other significant blocks in the file.
`;

export { veryLongString, jsonLikeObject, arrayOfStrings, templateLiteral, concatenatedString, chainedMethodCalls, sqlQuery, pathOperations, regexPattern, urlString, base64Encoded, hexString, binaryString, multiLineComment };
