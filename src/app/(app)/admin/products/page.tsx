import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select } from "@/lib/db";
import {
  parseSort,
  sortRows,
  type Accessors,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import type { Product } from "@/actions/product-actions";
import { channelLabel, rankShort } from "@/lib/labels";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Th,
  yen,
} from "@/components/ui";
import { SortableTh } from "@/components/SortableTh";
import { ProductForm, ProductRow } from "./ProductForm";

const BASE = "/admin/products";

export const metadata = { title: "商品マスタ（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 商品マスタ。販売単価と、代理店ランクごとの報酬額をここで持つ。
 * 受注が入ると「商品名」でこの表を引き、ランクに応じた金額で報酬を立てる。
 * つまり価格改定も新商品もこの画面だけで完結する必要がある。
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function str(r: Row, k: string): string {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

/** 空欄（未設定）と 0 円は意味が違うので、null のまま持ち上げる。 */
function numOrNull(r: Row, k: string): number | null {
  const v = r[k];
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toProduct(r: Row): Product {
  return {
    id: str(r, "id"),
    name: str(r, "name"),
    price: numOrNull(r, "price_incl_tax"),
    rewardTarget: str(r, "reward_target") !== "対象外",
    amountSo: numOrNull(r, "amount_so"),
    amountNiji: numOrNull(r, "amount_niji"),
    amountHanbai: numOrNull(r, "amount_hanbai"),
    amountToritsugi: numOrNull(r, "amount_toritsugi"),
    bonus10: str(r, "bonus_10") === "対象",
    points: numOrNull(r, "points") ?? 0,
    sortOrder: numOrNull(r, "sort_order") ?? 0,
    active: r["active"] !== false,
  };
}

/** 報酬の対象なのに、4つのランクすべてが未設定か0円。売れても報酬が立たない。 */
function rewardMissing(p: Product): boolean {
  return (
    p.rewardTarget &&
    [p.amountSo, p.amountNiji, p.amountHanbai, p.amountToritsugi].every(
      (v) => v === null || v === 0,
    )
  );
}

/**
 * 販売単価が入っていない。
 * お客様のお支払額が決まらないので、受注の登録でつまずく。
 * 「0円」は無料と決めた商品なので、未入力（null）だけを拾う。
 */
function priceMissing(p: Product): boolean {
  return p.price === null;
}

/** 商品名の並び。注意書きに「どの商品か」を書き出すのに使う。 */
function nameList(items: Product[]): string {
  return items.map((p) => p.name || "（商品名未設定）").join("・");
}

/** 並び替えに使える列。 */
const SORT_COLUMNS = [
  "name",
  "price",
  "so",
  "niji",
  "hanbai",
  "toritsugi",
  "order",
];

/** 既定は「並び順」の小さい順。受注の画面に出る順番と同じ。 */
const DEFAULT_SORT: SortState = { column: "order", desc: false };

function Head({ sort, params }: { sort: SortState; params: SearchParams }) {
  const th = (column: string, label: string, align: "left" | "right" = "right") => (
    <SortableTh
      column={column}
      label={label}
      sort={sort}
      basePath={BASE}
      params={params}
      align={align}
    />
  );

  return (
    <thead>
      <tr>
        {th("name", "商品名", "left")}
        {th("price", "販売単価（税別）")}
        <Th align="center">報酬</Th>
        {/* 見出しの呼び方は src/lib/labels.ts に寄せる。
            データベースには「2次代理店」で入っているが、2026-06-17 の呼称変更どおり
            画面には「統括代理店」と出す。保存する値も報酬の計算も、これまでどおり。 */}
        {th("so", rankShort("総販売代理店"))}
        {th("niji", rankShort("2次代理店"))}
        {/* この列だけはランクではなく販路種別（channel）の報酬額なので channelLabel を使う */}
        {th("hanbai", channelLabel("販売代理店"))}
        {th("toritsugi", rankShort("取次店"))}
        {/* ポイント列は出さない。ポイント運用は 2026-08-19 の打合せで取りやめが決まった。
            データ（points 列）は消していないので、再開するときはこの列を戻すだけでよい。 */}
        {th("order", "並び順")}
        <Th align="right">操作</Th>
      </tr>
    </thead>
  );
}

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let products: Product[] = [];
  let loadError: string | null = null;
  try {
    const rows = await select<Row>("products?select=*&order=sort_order.asc,id.asc");
    products = rows.map(toProduct);
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "商品マスタを読み込めませんでした。時間をおいて画面を開き直してください。";
  }

  const header = (
    <PageHeader
      title="商品マスタ"
      description="販売単価と、代理店ランクごとの報酬額をここで管理します。報酬の金額はこの表から引いているため、価格改定も新商品の追加もこの画面だけで完結します。表の見出しを押すと、単価や報酬額の大きい順に並び替えられます。"
    />
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          商品マスタを読み込めませんでした。{loadError}
          <br />
          金額が確認できないため、この画面からの追加・修正も控えてください。
          しばらく待っても直らない場合は、保存先の接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  const accessors: Accessors<Product> = {
    name: (p) => p.name,
    price: (p) => p.price,
    so: (p) => p.amountSo,
    niji: (p) => p.amountNiji,
    hanbai: (p) => p.amountHanbai,
    toritsugi: (p) => p.amountToritsugi,
    order: (p) => p.sortOrder,
  };
  const ordered = sortRows(products, sort.column, sort.desc, accessors);

  const active = ordered.filter((p) => p.active);
  const stopped = ordered.filter((p) => !p.active);
  const rewardCount = active.filter((p) => p.rewardTarget).length;
  const missing = active.filter(rewardMissing);
  const noPrice = active.filter(priceMissing);
  const highest = active.reduce((max, p) => Math.max(max, p.price ?? 0), 0);
  // 単価と報酬額のどちらかが欠けている商品。表の行にも色を付けて見つけやすくする。
  const needsInput = active.filter((p) => rewardMissing(p) || priceMissing(p)).length;

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="取扱中の商品"
          value={String(active.length)}
          unit="件"
          hint="受注のときに選べる商品"
        />
        <StatTile
          label="報酬の対象"
          value={String(rewardCount)}
          unit="件"
          hint={
            active.length > 0
              ? `対象外 ${active.length - rewardCount} 件は売れても報酬が立ちません`
              : "報酬が発生する商品の数"
          }
        />
        <StatTile
          label="いちばん高い単価（税別）"
          value={highest > 0 ? yen(highest) : "—"}
          tone="gold"
          hint="取扱中の商品の単価（税別）"
        />
        <StatTile
          label="取扱を止めた商品"
          value={String(stopped.length)}
          unit="件"
          hint={stopped.length > 0 ? "下の表にまとめています" : "いまはありません"}
        />
        <StatTile
          label="金額の入力待ち"
          value={String(needsInput)}
          unit="件"
          tone={needsInput > 0 ? "warn" : "default"}
          hint={
            needsInput > 0
              ? "販売単価か報酬額が空欄の商品。表では行に色が付いています"
              : "販売単価も報酬額もそろっています"
          }
        />
      </div>

      {missing.length > 0 ? (
        <Notice tone="warn">
          報酬の対象なのに、ランク別の報酬額がどこにも入っていない商品が {missing.length} 件あります
          （{nameList(missing)}）。
          このままだと売れても報酬が立ちません。金額を入れるか、報酬の対象から外してください。
        </Notice>
      ) : null}

      {noPrice.length > 0 ? (
        <Notice tone="warn">
          販売単価が入っていない商品が {noPrice.length} 件あります（{nameList(noPrice)}）。
          お客様のお支払額が決まらないため、この商品での受注はご案内できません。
          表の「内容を直す」から税別の単価を入れてください。
        </Notice>
      ) : null}

      <Card title={`取扱中の商品　${active.length} 件`}>
        {active.length === 0 ? (
          <EmptyState
            title="取扱中の商品がまだありません"
            description="下の「新しい商品を追加」から登録してください。登録した商品名と受注の商品名が一致したときに、ランク別の報酬額が使われます。"
          />
        ) : (
          <>
            <Table>
              <Head sort={sort} params={params} />
              <tbody>
                {active.map((p) => (
                  <ProductRow key={p.id} product={p} />
                ))}
              </tbody>
            </Table>
            <p className="border-t border-ink-800 px-5 py-3.5 text-xs leading-relaxed text-ink-400">
              報酬額は1台あたりの金額です。受注の台数を掛けた額が、その代理店の報酬になります。
              「—」は金額が未入力、「¥0」は報酬を出さないと決めた商品です。
              金額を直しても、すでに計上ずみの報酬は変わりません。これから登録される受注から新しい金額になります。
              <br />
              色が付いている行は、販売単価か報酬額が空欄のままの商品です。売る前に金額を入れてください。
            </p>
          </>
        )}
      </Card>

      <Card title={`取扱を止めた商品　${stopped.length} 件`}>
        {stopped.length === 0 ? (
          <EmptyState
            title="取扱を止めた商品はありません"
            description="使わなくなった商品は、上の表の「取扱を止める」でここに移せます。削除ではないので、いつでも元に戻せます。"
          />
        ) : (
          <>
            <Table>
              <Head sort={sort} params={params} />
              <tbody>
                {stopped.map((p) => (
                  <ProductRow key={p.id} product={p} />
                ))}
              </tbody>
            </Table>
            <p className="border-t border-ink-800 px-5 py-3.5 text-xs leading-relaxed text-ink-400">
              ここに並ぶ商品は、いまは売っていないものです。過去の受注はこの金額を参照しているため残してあります。
            </p>
          </>
        )}
      </Card>

      <Card title="新しい商品を追加">
        <ProductForm />
      </Card>

      <Notice tone="info">
        商品は削除できません。過去の受注が商品名でこの表を引いて報酬額を出しているため、
        消すと受注の金額の根拠がたどれなくなります。
        使わなくなった商品は「取扱を止める」を押してください。「取扱を止めた商品」に移るだけで、
        過去の受注も、計上ずみの報酬もそのまま残ります。いつでも取扱を再開できます。
      </Notice>
    </div>
  );
}
