require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Googleドライブから最新の画像を取得
async function getLatestImageFromDrive() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || require('fs').readFileSync('credentials.json', 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
    orderBy: 'createdTime desc',
    pageSize: 1,
    fields: 'files(id, name, webContentLink)',
  });

  if (!res.data.files || res.data.files.length === 0) {
    throw new Error('フォルダに画像が見つかりません');
  }

  const file = res.data.files[0];
  console.log(`取得した画像: ${file.name}`);

  // ファイルを一般公開してURLを取得
  const authClient = await auth.getClient();
  await drive.permissions.create({
    fileId: file.id,
    requestBody: { role: 'reader', type: 'anyone' },
    auth: authClient,
  });

  const imageUrl = `https://drive.google.com/uc?id=${file.id}`;

  // ローカルにもダウンロード（キャプション生成用）
  const destPath = path.join(__dirname, 'temp_image' + path.extname(file.name));
  const dest = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' },
      (err, res) => {
        if (err) return reject(err);
        res.data.pipe(dest);
        dest.on('finish', resolve);
        dest.on('error', reject);
      }
    );
  });
// 投稿済みフォルダに移動する関数を返す
  const moveToPosted = async () => {
    await drive.files.update({
      fileId: file.id,
      addParents: '1bcCckhx9JPFVlrH9zaReRGt74fT3lA2L',
      removeParents: folderId,
      fields: 'id, parents',
    });
    console.log('投稿済みフォルダに移動しました');
  };

  return { filePath: destPath, fileName: file.name, imageUrl, moveToPosted };
}

// キャプション生成
async function generateCaption(imagePath, fileName) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const character = fileName.includes('leo') ? 'レオ（マルプー）' :
                    fileName.includes('wata') ? 'わたあめ（ビションフリーゼ）' :
                    'レオ＆わたあめ';

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const prompt = `
あなたはインスタグラムの運用担当です。
この犬の写真を見て、以下の条件でインスタグラムの投稿文を作成してください。
また、前置きや説明は一切不要です。

【ブランド情報】
- ブランド名：もふわん
- 今回の主役：${character}
- コンセプト：大人かわいいわんちゃんデザインアパレル
- 販売：BASEショップ

【投稿文の条件】
- 200文字以内
- 絵文字を2〜3個使う
- 最後に「プロフィールリンクから見てね」を入れる
- ハッシュタグを10個生成する
- #もふわん は必ず入れる

投稿文とハッシュタグを分けて出力してください。
  `;

  const result = await model.generateContent([
    prompt,
    { inlineData: { mimeType, data: base64Image } },
  ]);

  const text = result.response.text();

  // 投稿文とハッシュタグを結合
  return text.replace(/\*\*投稿文\*\*\n?/, '')
             .replace(/\*\*ハッシュタグ\*\*\n?/, '\n')
             .replace(/---\n?/g, '')
             .trim();
}

// Instagramに投稿
async function postToInstagram(imageUrl, caption) {
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;

  console.log('Instagramにメディアをアップロード中...');

  // ステップ1：メディアコンテナ作成
  const containerRes = await fetch(
    `https://graph.instagram.com/v21.0/${accountId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: token,
      }),
    }
  );

  const container = await containerRes.json();
  if (container.error) throw new Error(`メディア作成エラー: ${container.error.message}`);

  console.log(`メディアコンテナ作成完了: ${container.id}`);

  // ステップ2：少し待つ
  await new Promise(r => setTimeout(r, 3000));

  // ステップ3：投稿を公開
  const publishRes = await fetch(
    `https://graph.instagram.com/v21.0/${accountId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: container.id,
        access_token: token,
      }),
    }
  );

  const publish = await publishRes.json();
  if (publish.error) throw new Error(`投稿エラー: ${publish.error.message}`);

  console.log(`✅ Instagram投稿完了！投稿ID: ${publish.id}`);
  return publish.id;
}

// メイン処理
async function main() {
  console.log('Googleドライブから最新画像を取得中...');
  const { filePath, fileName, imageUrl, moveToPosted } = await getLatestImageFromDrive();

  console.log('キャプション生成中...');
  const caption = await generateCaption(filePath, fileName);

  console.log('\n=== 生成されたキャプション ===\n');
  console.log(caption);

  console.log('\nInstagramに投稿中...');
  await postToInstagram(imageUrl, caption);

  // 投稿済みフォルダに移動
  await moveToPosted();
  // 一時ファイルを削除
  fs.unlinkSync(filePath);
  console.log('\n🎉 完了！');
}

main().catch(err => console.error('エラー:', err.message));