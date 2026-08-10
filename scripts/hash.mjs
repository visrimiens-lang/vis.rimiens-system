// パスワードの bcrypt ハッシュを作る。使い方: npm run hash -- 'パスワード'
import bcrypt from "bcryptjs";
const pw = process.argv[2];
if (!pw) {
  console.error("使い方: npm run hash -- 'パスワード'");
  process.exit(1);
}
console.log(await bcrypt.hash(pw, 10));
