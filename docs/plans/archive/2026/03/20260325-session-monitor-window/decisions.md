# Decisions

## 2026-03-25

- 第 1 slice は `Home` から monitor を切り出した独立 window に絞る
- window は「細い、縦長、コンパクト」を正本イメージにする
- `Session Monitor` の truth source は既存どおり Main Process の open session / live state を使う
- 初期実装では「端っこに置きやすい narrow window」を目指し、自動吸着までは入れない
- monitor window は初期 slice から `always on top` を必須にする
- renderer は新規 entry を増やさず、`index.html?mode=monitor` で `HomeApp` の compact monitor mode を再利用する
