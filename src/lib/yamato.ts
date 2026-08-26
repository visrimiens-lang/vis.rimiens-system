import "server-only";

/**
 * ヤマトB2クラウドAPI（データ交換規約4.3版・2025/1/24）のクライアント。
 *
 * 「画面API利用なし」（サーバ間連携）のパターンで、送り状の発行を
 * こちらのサーバーだけで完結させる。流れは仕様書の4.2のとおり:
 *
 *   1. 仮データ登録・データチェック  POST /b2/p/editA?api_user_id=◯◯
 *   2. 送り状発行（伝票番号採番）    POST /b2/p/new?issue_editA&display=0&print_type=0
 *   3. 印刷状態確認                  GET  /b2/p/polling?issue_no=◯◯&display=0
 *   4. PDFダウンロード               GET  /b2/p/getfile?display=0&issue_no=◯◯&fileonly=1
 *   5. 伝票番号取得                  GET  /b2/p/editA?spool&_RXID=◯◯
 *
 * ■ 認証（仕様書5章）
 * 一連の業務の最初のリクエストだけ Authorization: Token {APIアクセス認証キー}。
 * 以降はレスポンスの Set-Cookie（セッションID・RXID）をそのまま返す。
 * セッションは最後の操作から60分で切れるので、1回の発行の中で使い切る。
 *
 * ■ 排他制御（仕様書7-3）
 * 送り状発行と仮データ削除には、直前のレスポンスで受け取った
 * feed.updated（ミリ秒）をそのまま載せる。古い値だと409が返る。
 *
 * ■ なぜPDFをこの流れの中で取るのか
 * PDF取得はセッション（Cookie）が前提で、B2側の保存にも期限がある。
 * あとから別リクエストで取りに行く作りにすると、セッションが切れていて
 * 取れない。発行の流れの中で取得し、こちらのデータベースに控えを残す。
 */

type Row = Record<string, unknown>;

/* ══════════════════ 設定 ══════════════════ */

export type B2Config = {
  baseUrl: string;
  /** B2クラウド画面「外部システムとの連携」で取得するAPIアクセス認証キー */
  accessKey: string;
  /** ヤマトとの契約時に発行されるAPI連携会社コード（api_user_id） */
  apiUserId: string;
  /** 請求先・顧客コード（12桁） */
  invoiceCode: string;
  /** 請求先・分類コード（3桁）。無い場合は空文字 */
  invoiceCodeExt: string;
  /** 請求先・運賃管理番号（2桁） */
  invoiceFreightNo: string;
  /** ご依頼主（発送元）。B2の必須項目 */
  shipper: { name: string; zip: string; address: string; tel: string };
  /** 送り状に印字する品名（全角25文字以内） */
  itemName: string;
};

/**
 * 環境変数から設定を読む。足りなければ、何が足りないかを返す。
 * キー自体はヤマトとの契約とB2画面でしか手に入らないので、
 * 未設定のままでも画面が壊れないよう、呼び出し側で出し分ける。
 */
export function b2Config(): { config: B2Config | null; missing: string[] } {
  const read = (k: string) => (process.env[k] ?? "").trim();
  const required = [
    "YAMATO_B2_ACCESS_KEY",
    "YAMATO_B2_API_USER_ID",
    "YAMATO_B2_INVOICE_CODE",
    "YAMATO_SHIPPER_NAME",
    "YAMATO_SHIPPER_ZIP",
    "YAMATO_SHIPPER_ADDRESS",
    "YAMATO_SHIPPER_TEL",
  ];
  const missing = required.filter((k) => !read(k));
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      baseUrl: read("YAMATO_B2_BASE_URL") || "https://newb2web.kuronekoyamato.co.jp",
      accessKey: read("YAMATO_B2_ACCESS_KEY"),
      apiUserId: read("YAMATO_B2_API_USER_ID"),
      invoiceCode: read("YAMATO_B2_INVOICE_CODE"),
      invoiceCodeExt: read("YAMATO_B2_INVOICE_CODE_EXT"),
      invoiceFreightNo: read("YAMATO_B2_INVOICE_FREIGHT_NO") || "01",
      shipper: {
        name: read("YAMATO_SHIPPER_NAME"),
        zip: read("YAMATO_SHIPPER_ZIP").replace(/[^0-9]/g, ""),
        address: read("YAMATO_SHIPPER_ADDRESS"),
        tel: read("YAMATO_SHIPPER_TEL"),
      },
      itemName: read("YAMATO_ITEM_NAME") || "眼筋トレーニングマシンVIS",
    },
    missing: [],
  };
}

/* ══════════════════ 出荷データの組み立て ══════════════════ */

export type OutboundOrder = {
  /** 受注のid。お客様管理番号（shipment_number）に入れて、採番結果と突き合わせる */
  orderId: string;
  name: string;
  zip: string;
  address: string;
  phone: string;
};

/**
 * 受注1件ぶんの出荷データ（仕様書9章・発払い）。
 *
 * 値はすべて文字列で送る（仕様書のサンプルがそうなっている）。
 * 空でよい項目は省く。B2側でチェックされ、エラーは entry ごとの
 * error[] と error_flg で返るので、こちらで仕様の再実装はしない。
 */
export function buildShipment(cfg: B2Config, o: OutboundOrder, shipDate: string): Row {
  return {
    shipment_number: o.orderId,
    service_type: "0", // 発払い
    is_cool: "0",
    shipment_date: shipDate, // YYYYMMDD。本日〜30日後まで
    // 「1」固定。複数口は同一くくりキーが要る決まりのため、送り状は1受注1枚にする
    package_qty: "1",
    input_system_type: "api",
    is_using_shipment_email: "0",
    is_using_delivery_email: "0",
    invoice_code: cfg.invoiceCode,
    invoice_code_ext: cfg.invoiceCodeExt,
    invoice_freight_no: cfg.invoiceFreightNo,
    shipper_name: cfg.shipper.name,
    shipper_telephone_display: cfg.shipper.tel,
    shipper_zip_code: cfg.shipper.zip,
    shipper_address: cfg.shipper.address,
    consignee_name: o.name,
    consignee_telephone_display: o.phone,
    consignee_zip_code: o.zip.replace(/[^0-9]/g, ""),
    consignee_address: o.address,
    item_name1: cfg.itemName,
  };
}

/* ══════════════════ feed の読み取り ══════════════════ */

export type FeedError = {
  error_property_name?: string;
  error_code?: string;
  error_description?: string;
};

export type FeedEntry = {
  id?: string;
  shipment?: Row;
  error?: FeedError[];
  title?: string;
  subtitle?: string;
  summary?: string;
};

type Feed = {
  title?: string;
  subtitle?: string;
  summary?: string;
  updated?: string;
  entry?: FeedEntry[];
};

const s_ = (r: Row | undefined, k: string): string => {
  const v = r?.[k];
  return v === null || v === undefined ? "" : String(v);
};

function parseFeed(text: string): Feed {
  try {
    const json = JSON.parse(text) as { feed?: Feed };
    return json.feed ?? {};
  } catch {
    return {};
  }
}

/** feed からエラーの説明を1文にまとめる（B2は title/summary/entry のどれかに入れてくる）。 */
function feedMessage(feed: Feed): string {
  const parts = [feed.title, feed.summary, feed.subtitle].filter(
    (v) => v && v !== "Error",
  );
  const first = feed.entry?.[0];
  if (first?.summary) parts.push(first.summary);
  return parts.join(" / ");
}

export class B2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 受注ごとのエラー（仮データ登録のデータチェック結果） */
    readonly entryErrors: { orderId: string; messages: string[] }[] = [],
  ) {
    super(message);
  }
}

/* ══════════════════ クライアント本体 ══════════════════ */

export class B2Client {
  /** B2から受け取ったCookie（セッションID・RXID）。1回の発行の中で持ち回る */
  private jar = new Map<string, string>();

  constructor(private cfg: B2Config) {}

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async request(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      /** 業務の最初のリクエストだけ true（仕様書5章の決まり） */
    auth?: boolean;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.auth) headers["Authorization"] = `Token ${this.cfg.accessKey}`;
    const cookie = this.cookieHeader();
    if (cookie) headers["Cookie"] = cookie;

    const res = await fetch(this.cfg.baseUrl + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      cache: "no-store",
      redirect: "manual",
    });

    // セッションID・RXIDを覚える。次のリクエストで返すのが仕様の前提
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
    return res;
  }

  /**
   * 仮データ登録・データチェック。
   * 戻りの entries には、B2が採番した tracking_number / created_ms が入っている
   * （この時点ではまだ伝票番号ではない。発行用の仮の番号）。
   */
  async register(shipments: Row[]): Promise<{
    updated: string;
    entries: { orderId: string; trackingNumber: string; createdMs: string; errorFlg: string; errors: string[] }[];
  }> {
    const res = await this.request(
      `/b2/p/editA?api_user_id=${encodeURIComponent(this.cfg.apiUserId)}`,
      {
        method: "POST",
        auth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feed: { entry: shipments.map((s) => ({ shipment: s })) } }),
      },
    );
    const feed = parseFeed(await res.text());
    if (res.status !== 200) {
      throw new B2Error(
        `仮データ登録に失敗しました（HTTP ${res.status}）。${feedMessage(feed)}`,
        res.status,
      );
    }
    const entries = (feed.entry ?? []).map((e) => ({
      orderId: s_(e.shipment, "shipment_number"),
      trackingNumber: s_(e.shipment, "tracking_number"),
      createdMs: s_(e.shipment, "created_ms"),
      // 0:正常 1:警告（発行できる） 9:エラー（発行できない）
      errorFlg: s_(e.shipment, "error_flg") || "0",
      errors: (e.error ?? [])
        .map((er) => er.error_description || er.error_code || "")
        .filter(Boolean),
    }));
    return { updated: feed.updated ?? "", entries };
  }

  /**
   * 仮データ削除。データチェックでエラーになった登録を片づけるのに使う。
   * 消さずに残すと、B2側に宙ぶらりんの仮データが溜まっていく。
   */
  async removeDrafts(updated: string, trackingNumbers: string[]): Promise<void> {
    const res = await this.request(`/b2/p/editA`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-HTTP-Method-Override": "DELETE /editA",
      },
      body: JSON.stringify({
        feed: {
          updated,
          entry: trackingNumbers.map((t) => ({ shipment: { tracking_number: t } })),
        },
      }),
    });
    // 片づけそのものは主目的ではないので、失敗しても投げない（呼び出し側が記録する）
    if (res.status !== 200) {
      console.error("[yamato] 仮データ削除に失敗", res.status, await res.text());
    }
  }

  /** 送り状発行。伝票番号が採番され、印刷データの作成が始まる。 */
  async issue(
    updated: string,
    targets: { trackingNumber: string; createdMs: string }[],
  ): Promise<{ issueNo: string; waitMs: number; updated: string }> {
    const res = await this.request(`/b2/p/new?issue_editA&display=0&print_type=0`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        feed: {
          updated,
          entry: targets.map((t) => ({
            shipment: {
              tracking_number: t.trackingNumber,
              created_ms: t.createdMs,
              service_type: "0",
              shipment_flg: "1",
            },
          })),
        },
      }),
    });
    const feed = parseFeed(await res.text());
    if (res.status !== 200) {
      const hint =
        res.status === 409
          ? "ほかの画面が同時にB2クラウドを操作しています。少し待ってからやり直してください。"
          : res.status === 419
            ? "B2クラウドが混み合っています。少し待ってからやり直してください。"
            : "";
      throw new B2Error(
        `送り状発行に失敗しました（HTTP ${res.status}）。${feedMessage(feed)} ${hint}`.trim(),
        res.status,
      );
    }
    return {
      issueNo: feed.title ?? "",
      // subtitle は帳票生成の想定時間（ミリ秒）。最初のポーリングまでの待ち時間に使う
      waitMs: Number(feed.subtitle ?? 0) || 1000,
      updated: feed.updated ?? updated,
    };
  }

  /**
   * 印刷状態確認。作成完了（200）になるまで1秒以上あけて確かめる（仕様書の決まり）。
   * 完了時のレスポンスに、伝票番号取得に使うRXIDが入っている。
   */
  async waitForPrint(issueNo: string, firstWaitMs: number): Promise<{ rxid: string }> {
    await sleep(Math.min(Math.max(firstWaitMs, 500), 10_000));
    const deadline = Date.now() + 40_000;
    for (;;) {
      const res = await this.request(
        `/b2/p/polling?issue_no=${encodeURIComponent(issueNo)}&display=0`,
      );
      const text = await res.text();
      if (res.status === 200) {
        const feed = parseFeed(text);
        return { rxid: feed.title ?? "" };
      }
      if (res.status !== 202) {
        throw new B2Error(
          `印刷データの作成に失敗しました（HTTP ${res.status}）。${feedMessage(parseFeed(text))}`,
          res.status,
        );
      }
      if (Date.now() > deadline) {
        throw new B2Error(
          `印刷データの作成が時間内に終わりませんでした（発行番号 ${issueNo}）。` +
            "伝票番号はB2クラウドの「発行済データの検索」でご確認ください。",
          202,
        );
      }
      await sleep(1_200); // 1秒未満の間隔は仕様で禁止されている
    }
  }

  /** 送り状PDFの取得。 */
  async downloadPdf(issueNo: string): Promise<Uint8Array | null> {
    const res = await this.request(
      `/b2/p/getfile?display=0&issue_no=${encodeURIComponent(issueNo)}&fileonly=1`,
    );
    if (res.status !== 200) return null; // PDFは控え。取れなくても発行は成立している
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * 伝票番号取得。発行済みの出荷データが、伝票番号つきで返る。
   * 取得したentryはB2側から消える（一度きり）ので、結果は必ず保存すること。
   * 0件のときは200のままエラーfeedが返る決まりで、3秒間隔で3回まで挑む（仕様書のとおり）。
   */
  async fetchIssued(rxid: string): Promise<{ orderId: string; invoiceNo: string }[]> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(`/b2/p/editA?spool&_RXID=${encodeURIComponent(rxid)}`);
      const feed = parseFeed(await res.text());
      const entries = (feed.entry ?? []).filter((e) => e.shipment);
      if (res.status === 200 && entries.length > 0 && feed.title !== "Error") {
        return entries.map((e) => ({
          orderId: s_(e.shipment, "shipment_number"),
          // 発行後の tracking_number が送り状の伝票番号
          invoiceNo: s_(e.shipment, "tracking_number"),
        }));
      }
      if (attempt >= 2) {
        throw new B2Error(
          "伝票番号を受け取れませんでした。送り状は発行済みです。" +
            "伝票番号はB2クラウドの「発行済データの検索」でご確認ください。",
          res.status,
        );
      }
      await sleep(3_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
