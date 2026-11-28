import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CharacterRuntimeSnapshot,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import {
  CharacterWorkspaceOperationCoordinator,
  type RunCharacterWorkspaceOperationExclusive,
} from "./character-workspace-operation-coordinator.js";

/** 直接ストレージと Worker 経由のストレージで共通に使う、同期値または非同期結果。 */
type Awaitable<T> = T | Promise<T>;
/** 個別 Character の ID がまだない作成処理を、カタログ内で直列化するためのキー。 */
export const CHARACTER_CATALOG_OPERATION_KEY = "__character-catalog__";

/** Character のカタログ・定義ファイルと実行用スナップショットを読み書きする保存境界。 */
export type CharacterCatalogServiceStorage = {
  /** 有効な Character を一覧化し、指定時にはアーカイブ済みも含める。 */
  listCharacters(options?: {
    includeArchived?: boolean;
  }): Awaitable<CharacterCatalogEntry[]>;
  /** 定義ファイルを読み込まず、指定 ID のカタログ項目を返す。 */
  getCharacterCatalogEntry(
    characterId: string,
  ): Awaitable<CharacterCatalogEntry | null>;
  /** 保存されたカタログ情報と定義・ノートの本文を合わせて読む。 */
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  /** カタログ項目と定義の初期ファイルを作成して返す。 */
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  /** 定義テキストとは別に、名前やアイコンなどのカタログ項目を更新する。 */
  updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Awaitable<CharacterDetail>;
  /** 定義とノートのファイルを書き換え、更新後の詳細を返す。 */
  updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Awaitable<CharacterDetail>;
  /** カタログ項目をアーカイブ状態に変更する。新規起動の選択対象から外す。 */
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  /** 起動時に指定した Character が有効なら返す。未指定・無効なら代替を選ばない。 */
  resolveLaunchCharacter(
    input: ResolveLaunchCharacterInput,
  ): Awaitable<CharacterDetail | null>;
  /** 指定 Character の現在の情報から実行用のスナップショットを作る。 */
  createRuntimeSnapshot(
    characterId: string,
  ): Awaitable<CharacterRuntimeSnapshot | null>;
  /** 既存のスナップショットの所有者を照合し、Turn が使用する定義を更新する。 */
  refreshRuntimeSnapshot(
    characterId: string,
    previousSnapshot: CharacterRuntimeSnapshot | null,
  ): Awaitable<CharacterRuntimeSnapshot>;
  /** Character のワークスペースとして扱うディレクトリを解決する。 */
  getCharacterDirectory(characterId: string): Awaitable<string | null>;
};

/** Character の永続操作を提供し、定義編集・アーカイブ・実行用定義の更新を同じキーで調停する。 */
export class CharacterService {
  /** 永続化とワークスペース調停に接続する。同じ調停器を他の利用側と共用できる。 */
  constructor(
    private readonly storage: CharacterCatalogServiceStorage,
    workspaceCoordinator: CharacterWorkspaceOperationCoordinator = new CharacterWorkspaceOperationCoordinator(),
  ) {
    this.workspaceOperations =
      workspaceCoordinator.runExclusive.bind(workspaceCoordinator);
  }

  private readonly workspaceOperations: RunCharacterWorkspaceOperationExclusive;

  /** 絞り込み条件をそのまま保存先へ渡し、カタログの一覧を返す。 */
  async listCharacters(options?: {
    includeArchived?: boolean;
  }): Promise<CharacterCatalogEntry[]> {
    return await this.storage.listCharacters(options);
  }

  /** ID 未指定なら検索せず、指定された項目のカタログ情報だけを返す。 */
  async getCharacterCatalogEntry(
    characterId: string,
  ): Promise<CharacterCatalogEntry | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacterCatalogEntry(characterId);
  }

  /** 指定された ID の定義・ノートを含む詳細を返す。空の ID は null とする。 */
  async getCharacter(characterId: string): Promise<CharacterDetail | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacter(characterId);
  }

  /** ID が確定していない新規作成をカタログ用の共通キーで直列化する。 */
  async createCharacter(input: CreateCharacterInput): Promise<CharacterDetail> {
    return this.workspaceOperations(
      CHARACTER_CATALOG_OPERATION_KEY,
      async () => await this.storage.createCharacter(input),
    );
  }

  /** 同じ Character の別の編集と重ならないようにメタデータを保存する。 */
  async updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Promise<CharacterDetail> {
    return this.workspaceOperations(
      input.characterId,
      async () => await this.storage.updateCharacterMetadata(input),
    );
  }

  /** 同じ Character の実行用定義の更新や編集と直列化して、定義・ノートを保存する。 */
  async updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Promise<CharacterDetail> {
    return this.workspaceOperations(
      input.characterId,
      async () => await this.storage.updateCharacterDefinition(input),
    );
  }

  /** 対象 Character の編集やスナップショット更新と直列化してアーカイブする。 */
  async archiveCharacter(characterId: string): Promise<CharacterCatalogEntry> {
    return this.workspaceOperations(
      characterId,
      async () => await this.storage.archiveCharacter(characterId),
    );
  }

  /** 起動に使う Character の解決を保存先に任せ、入力がなければ空の指定を渡す。 */
  async resolveLaunchCharacter(
    input?: ResolveLaunchCharacterInput | null,
  ): Promise<CharacterDetail | null> {
    return await this.storage.resolveLaunchCharacter(input ?? {});
  }

  /** 空の ID では何も読み取らず、指定時に保存先から実行用スナップショットを取得する。 */
  async createRuntimeSnapshot(
    characterId: string,
  ): Promise<CharacterRuntimeSnapshot | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.createRuntimeSnapshot(characterId);
  }

  /** Character ID がある場合にだけ、そのディレクトリを保存先に問い合わせる。 */
  async getCharacterDirectory(characterId: string): Promise<string | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacterDirectory(characterId);
  }

  /** 編集と処理順を共有し、同じ Character の過去のスナップショットをもとに実行用定義を更新する。 */
  async refreshRuntimeSnapshot(
    characterId: string,
    previousSnapshot: CharacterRuntimeSnapshot | null,
  ): Promise<CharacterRuntimeSnapshot> {
    return this.workspaceOperations(
      characterId,
      async () =>
        await this.storage.refreshRuntimeSnapshot(
          characterId,
          previousSnapshot,
        ),
    );
  }
}
