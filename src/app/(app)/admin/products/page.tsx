import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select } from "@/lib/db";
import type { Product } from "@/actions/product-actions";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  yen,
} from "@/components/ui";
import { ProductForm, ProductRow } from "./ProductForm";

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

function Head() {
  return (
    <thead>
      <tr>
        <Th>商品名</Th>
        <Th align="right">販売単価</Th>
        <Th align="center">報酬</Th>
        <Th align="right">総販売代理店</Th>
        <Th align="right">2次代理店</Th>
        <Th align="right">販売代理店</Th>
        <Th align="right">取次店</Th>
        <Th align="right">ポイント</Th>
        <Th align="right">並び順</Th>
        <Th align="right">操作</Th>
      </tr>
    </thead>
  );
}

export default async function AdminProductsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

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
      description="販売単価と、代理店ランクごとの報酬額をここで管理します。報酬の金額はこの表から引いているため、価格改定も新商品の追加もこの画面だけで完結します。"
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

  const active = products.filter((p) => p.active);
  const stopped = products.filter((p) => !p.active);
  const rewardCount = active.filter((p) => p.rewardTarget).length;
  const missing = active.filter(rewardMissing);
  const highest = active.reduce((max, p) => Math.max(max, p.price ?? 0), 0);

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          label="いちばん高い単価"
          value={highest > 0 ? yen(highest) : "—"}
          tone="gold"
          hint="取扱中の商品の税込単価"
        />
        <StatTile
          label="取扱を止めた商品"
          value={String(stopped.length)}
          unit="件"
          hint={stopped.length > 0 ? "下の表にまとめています" : "いまはありません"}
        />
      </div>

      {missing.length > 0 ? (
        <Notice tone="warn">
          報酬の対象なのに、ランク別の報酬額がどこにも入っていない商品が {missing.length} 件あります
          （{missing.map((p) => p.name || "（商品名未設定）").join("・")}）。
          このままだと売れても報酬が立ちません。金額を入れるか、報酬の対象から外してください。
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
              <Head />
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
              <Head />
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
