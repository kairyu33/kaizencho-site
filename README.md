# 献立帖 ・ 成功のレシピ

千の記事から、今日のあなたに届く一献を。

このリポジトリは [GitHub Pages](https://pages.github.com/) で配信される、完全に静的な公開サイトです。

## 構成

```
.
├── index.html          # メインページ（ガチャ・投票・目録）
├── data.json           # 記事データ・本日のお品書き（管理側でビルド出力）
├── assets/
│   ├── style.css       # 和紙・料亭テーマのスタイル
│   └── app.js          # ガチャ抽選ロジック・投票・目録
└── .nojekyll           # GitHub Pages の Jekyll 処理を無効化
```

## データ更新フロー

データソース: [note-article-manager](https://note-article-manager-git-main-kairyu33s-projects.vercel.app/admin)（記事マスタDB）

1. note-article-manager の管理画面で記事を追加・編集
2. recipe-gacha 管理画面（"帳場"）で「外部DB同期」→「品位再配分」→「データ出力」
3. 出力された `data.json` をこのリポジトリへ commit & push
4. GitHub Pages が数十秒で反映

## ライセンス

公開サイトのコード自体はソースコードとして閲覧可能ですが、収録される記事タイトルおよび関連コンテンツの著作権は「成功のレシピ」に帰属します。
