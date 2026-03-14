# Decisions

- Codex SDK の text payload は system/user を分離せず、WithMate 側の論理分割だけを保持する
- text prompt には Session Context と Referenced Paths を入れない
- 添付は SDK structured input と additionalDirectories だけで扱う
