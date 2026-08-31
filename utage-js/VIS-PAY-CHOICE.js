/*
 * VIS-PAY-CHOICE : 商品の欄の下に「お支払い方法」と「オプション」を出す
 * 2026-08-28
 *
 * ■ なぜ要るか
 *
 * UTAGE は「商品詳細（価格ラインナップ）」の行がそのままラジオボタンになる。
 * 支払方法とオプションの組み合わせぶん行を用意するので、そのまま出すと
 * 同じ商品が12行並ぶ画面になり、お客様にはどれを選べばよいか分からない。
 *
 * そこで
 *   ・商品の欄は、いま選ばれている1行だけを出す
 *   ・その下に「お支払い方法」（クレジット／銀行振込／アプラス）
 *   ・さらに OP①・OP② のチェック欄
 * を出し、選ばれた組み合わせに当たる行を裏で押す。
 *
 * ■ 行の見分け方
 *
 * 行の表示名に入っている印で判断する。ここを変えるときは商品側の
 * 「連携フォームでの表記」も合わせること。
 *   支払方法 … 【銀行振込】【アプラス（ローン）】、印が無ければクレジット
 *   OP①    … 「OP①」
 *   OP②    … 「OP②」
 *
 * ■ 触ってよい場所・いけない場所
 *
 * 商品行（table.payment-method の中）は、td や innerHTML をまとめて書き換えない。
 * 書き換えると UTAGE が行を作り直し、選んだ内容が先頭に戻る
 * （2026-08-27 に VIS-BUMP-TOTAL でこの不具合を出した）。
 * ここでやるのは、選ばれていない行を display:none にすること、行を押すこと、
 * それと stripMarkers() が文字の節だけから【】の印を消すことの3つ。
 *
 * 印そのものを商品側の表示名から消してはいけない。
 * 消すと支払方法を見分けられなくなり、銀行振込・アプラスの選択肢が
 * 画面から丸ごと消える（2026-08-31 に実際に起こした）。
 * 見た目が気になるときは、この stripMarkers() で表示だけを落とす。
 *
 * ■ オーダーバンプは使わない
 *
 * UTAGE のオーダーバンプは1つの決済フォームに1つしか出せず、しかも
 * クレジットカード払いの行が選ばれているときしか出ない。OP① をバンプで
 * 出していたころは、銀行振込・アプラスでオプションが選べなかった。
 * 組み合わせの行に差し替える方式にしたので、どの支払方法でも選べる。
 * OP① のバンプ商品は「表示しない」に戻してあること（残すと二重に出る）。
 *
 * ■ お支払い合計
 *
 * もとは VIS-TOTAL-ROW が「購入商品」の下に合計を足していた。同じ役目を
 * このスクリプトが引き受けるので、VIS-TOTAL-ROW は外すこと。
 */
(function () {
  "use strict";

  var C = {
    panel: "#15151b",
    line: "#2f2f3a",
    text: "#efece4",
    dim: "#9a9aa6",
    gold: "#c9a96a",
    goldLight: "#e7cf95",
  };

  /* 支払方法ごとの見せ方。種類の判定は rowInfo() が行う。 */
  var KINDS = [
    {
      key: "card",
      title: "クレジットカード",
      lead: "VISA / Mastercard / JCB / AMEX / Diners（一回払い）",
      note: null,
    },
    {
      key: "bank",
      title: "銀行振込",
      lead: "ご注文後、お振込先をメールでお送りします",
      note:
        "お振込先は、ご注文後にお送りする確認メールに記載しています。\n" +
        "※ 注文者と同じ本人名義にてお振込みをお願いいたします。\n" +
        "※ 振込手数料はお客様のご負担となります。\n" +
        "※ ご入金の確認後に、商品の手配へ進みます。",
    },
    {
      key: "aplus",
      title: "アプラス（ショッピングクレジット）",
      lead: "分割でのお支払い。担当者よりお申し込みURLをお送りします",
      note:
        "ご注文後、担当者よりアプラスのお申し込みURLをメールでお送りします。\n" +
        "※ この画面ではお支払いは確定しません。URLからのお手続きが必要です。\n" +
        "※ 分割回数によって、お支払い総額が変わる場合があります。\n" +
        "※ 審査の結果によっては、ご希望に添えない場合がございます。",
    },
  ];

  var ID = "vis-pay-choice";

  function radios() {
    return Array.prototype.slice.call(
      document.querySelectorAll('input[name="payment-method"]')
    );
  }

  /** 行の表示文字。商品名と金額が入っている。 */
  function textOf(r) {
    var tr = r.closest("tr");
    return tr ? (tr.innerText || tr.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  /** 【銀行振込】のような、支払方法を見分けるためだけの但し書きを外す。 */
  function cleanName(t) {
    return t
      .replace(/【[^】]*】/g, "")
      .replace(/合計[\s\d,]*円\s*\(税込\)/g, "")
      .replace(/[0-9,]+円\s*（税込）/g, "")
      .replace(/※.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function yenOf(t) {
    var m = (t || "").replace(/,/g, "").match(/([0-9]+)\s*円/);
    return m ? Number(m[1]) : 0;
  }

  function comma(n) {
    return n.toLocaleString("ja-JP");
  }

  /**
   * 購入商品の明細（table.summary）を読む。
   * オーダーバンプを足した状態を UTAGE が作ってくれるので、これを正とする。
   */
  function summaryLines() {
    var tb = document.querySelector("table.summary");
    var out = [];
    if (!tb) return fromSelectedRow(out);
    Array.prototype.forEach.call(tb.rows, function (r) {
      if (!r.cells.length || r.cells[0].tagName === "TH") return;
      if (String(r.className).indexOf("vis-") === 0) return;
      var name = cleanName((r.cells[0].innerText || r.cells[0].textContent || "").trim());
      var price = yenOf(r.cells.length > 1 ? r.cells[1].innerText || r.cells[1].textContent : "");
      if (!name && !price) return;
      out.push({ name: name, price: price });
    });
    return out.length ? out : fromSelectedRow(out);
  }

  /**
   * 銀行振込・アプラスを選ぶと、UTAGE は「購入商品」の明細を出さない。
   * そのときは、選ばれている行そのものから注文内容を作る。
   * ここが無いと、上のご注文内容が前に選んでいた方法の金額のまま残る。
   */
  function fromSelectedRow(out) {
    var r = document.querySelector('input[name="payment-method"]:checked');
    if (!r) return out;
    var t = textOf(r);
    var name = cleanName(t);
    var price = yenOf((t.match(/合計\s*[0-9,]+\s*円/) || [""])[0]);
    if (name || price) out.push({ name: name, price: price });
    return out;
  }

  /**
   * 行1つぶんの中身。表示名の印から、支払方法とオプションの有無を読む。
   * 商品側の「連携フォームでの表記」を変えるときは、ここも合わせること。
   *
   * 読んだ結果は行の要素に覚えさせる。
   * このあと stripMarkers() が画面から【銀行振込】などの印を消すため、
   * 毎回読み直すと二度目から全部クレジット扱いになり、
   * 銀行振込・アプラスの選択肢が画面から消える（2026-08-31 に実際に起きた）。
   * UTAGE が行を作り直したときは新しい要素になり、印の付いた文字から読み直される。
   */
  function rowInfo(r) {
    if (!r.__visKind) {
      var t = textOf(r);
      var kind = "card";
      if (/アプラス|ローン/.test(t)) kind = "aplus";
      else if (/銀行振込|振込/.test(t)) kind = "bank";
      r.__visKind = kind;
      r.__visOp1 = /OP①/.test(t);
      r.__visOp2 = /OP②/.test(t);
    }
    return { radio: r, kind: r.__visKind, op1: r.__visOp1, op2: r.__visOp2 };
  }

  /**
   * 【銀行振込】のような、支払方法を見分けるためだけの印を画面から消す。
   *
   * 印は商品側の表示名に入れてあり、種類の判定に要る。
   * ただしお客様には不要で、商品名が長いところへ入るため行が折り返して読みにくい。
   * そこで、判定を済ませてから表示だけを消す。
   *
   * 消すのは文字の節（テキストノード）だけにする。
   * td の textContent をまとめて書き換えると中のラジオボタンごと作り直され、
   * 選んだ支払方法が元に戻ってしまう（VIS-BUMP-TOTAL で起きた不具合）。
   */
  function stripMarkers() {
    var tb = document.querySelector("table.payment-method");
    if (!tb) return;
    radios().forEach(rowInfo); // 先に種類を読んで覚えさせる
    var walker = document.createTreeWalker(tb, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue;
      if (t.indexOf("【") < 0 && t.indexOf("／") < 0) continue;
      /*
       * 印を消し、品目の区切り（／）で改行する。
       *
       * 商品名は「本体 ／ 事務手数料 ／ OP① ／ OP②」と1本につながっていて、
       * 狭い幅では途中で勝手に折り返し、どこまでが1品目か読めなかった。
       * 品目ごとに行を分けると、何がいくらなのかがそのまま読める。
       *
       * 改行は「\n」を入れるだけにして、表示は CSS（white-space: pre-line）に任せる。
       * <br> を入れるには innerHTML を書き換えることになり、
       * 中のラジオボタンごと作り直されて選択が飛ぶ。
       */
      t = t.replace(/【[^】]*】/g, "").replace(/[ 　]{2,}/g, " ");
      t = t.replace(/\s*／\s*/g, " ／\n");
      if (n.nodeValue !== t) n.nodeValue = t;
    }
  }

  var STYLE_ID = "vis-pay-choice-style";

  /**
   * 商品の行を縦に積む。
   *
   * もとは「商品名｜価格」の2列で、名前が長いと左が潰れて読めなかった。
   * 品目を縦に並べ、そのすぐ下に合計を出す形にそろえる。
   *
   * 見た目は CSS だけで変える。表の作り（td の並び）には触らない。
   */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent =
      "table.payment-method tbody td{display:block;width:auto;text-align:left;" +
      "white-space:pre-line;border:0;padding:2px 0;}" +
      "table.payment-method tbody tr{display:block;padding:10px 0;}" +
      "table.payment-method thead{display:none;}" +
      "table.payment-method tbody td:last-child{color:" + C.goldLight + ";font-weight:600;}";
    document.head.appendChild(st);
  }

  function rowsInfo() {
    return radios().map(rowInfo);
  }

  /** 支払方法とオプションの組み合わせに当たる行。無ければ null。 */
  function findRow(kind, op1, op2) {
    var all = rowsInfo();
    for (var i = 0; i < all.length; i++) {
      var x = all[i];
      if (x.kind === kind && x.op1 === op1 && x.op2 === op2) return x.radio;
    }
    return null;
  }

  /** いま選ばれている行の中身。 */
  function current() {
    var r = document.querySelector('input[name="payment-method"]:checked');
    return r ? rowInfo(r) : null;
  }

  /** このページに出ている支払方法（行がある種類だけ）。 */
  function choices() {
    var seen = [];
    rowsInfo().forEach(function (x) {
      if (seen.indexOf(x.kind) < 0) seen.push(x.kind);
    });
    var out = [];
    KINDS.forEach(function (k) {
      if (seen.indexOf(k.key) >= 0) out.push({ kind: k });
    });
    return out;
  }

  /**
   * その組み合わせの行を選ぶ。
   * ぴったりの行が無ければ、オプションを落として近いものに寄せる
   * （商品の登録が足りないときに、何も選べなくなるのを防ぐ）。
   */
  function select(kind, op1, op2) {
    var r =
      findRow(kind, op1, op2) ||
      findRow(kind, op1, false) ||
      findRow(kind, false, op2) ||
      findRow(kind, false, false);
    if (r && !r.checked) r.click();
    repaintSoon();
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * 商品の欄は、いま選ばれている行だけを出す。
   * 支払方法ちがいの同じ商品が3行並ぶのを避けるためで、
   * 行の中の文字には触らない（触ると選択が先頭に戻る）。
   */
  function showSelectedRowOnly() {
    var table = document.querySelector("table.payment-method");
    if (!table) return null;
    radios().forEach(function (r) {
      var tr = r.closest("tr");
      if (!tr) return;
      var want = r.checked ? "" : "none";
      if (tr.style.display !== want) tr.style.display = want;
    });
    return table.closest(".form-group") || table.parentElement;
  }

  function head(text, required) {
    var h = el(
      "div",
      "font-size:15px;font-weight:700;color:" +
        C.text +
        ";border-bottom:1px solid " +
        C.line +
        ";padding-bottom:8px;margin-bottom:10px"
    );
    h.appendChild(document.createTextNode(text));
    if (required) {
      h.appendChild(
        el(
          "span",
          "margin-left:8px;font-size:11px;font-weight:700;color:#fff;" +
            "background:#d9534f;border-radius:4px;padding:2px 6px;vertical-align:middle",
          "必須"
        )
      );
    }
    return h;
  }

  function build() {
    var exist = document.getElementById(ID);
    if (exist) return exist;
    var group = showSelectedRowOnly();
    if (!group) return null;

    var wrap = el("div", "margin:18px 0");
    wrap.id = ID;

    var payHead = head("お支払い方法", true);
    var list = el("div", "display:flex;flex-direction:column;gap:8px");
    var note = el(
      "div",
      "display:none;margin-top:10px;background:rgba(201,169,106,.07);border:1px solid " +
        C.gold +
        ";border-radius:8px;padding:12px 14px;font-size:12.5px;line-height:1.9;color:" +
        C.text +
        ";white-space:pre-line"
    );

    wrap.appendChild(payHead);
    wrap.appendChild(list);
    wrap.appendChild(note);

    group.parentNode.insertBefore(wrap, group.nextSibling);

    wrap._payHead = payHead;
    wrap._list = list;
    wrap._note = note;
    wrap._rendered = "";
    return wrap;
  }

  function optionRow(c, checked) {
    var lab = el(
      "label",
      "display:flex;align-items:flex-start;gap:10px;cursor:pointer;background:" +
        C.panel +
        ";border:1px solid " +
        (checked ? C.gold : C.line) +
        ";border-radius:8px;padding:13px 15px;transition:border-color .15s"
    );
    lab.setAttribute("data-vis-pay", c.kind.key);

    var input = document.createElement("input");
    input.type = "radio";
    input.name = "vis-pay-choice";
    input.value = c.kind.key;
    input.checked = !!checked;
    input.style.cssText = "margin:3px 0 0;flex:0 0 auto;accent-color:" + C.gold;

    var body = el("div", "flex:1 1 auto;min-width:0");
    body.appendChild(
      el("div", "font-size:14px;font-weight:700;color:" + C.text, c.kind.title)
    );
    body.appendChild(
      el(
        "div",
        "font-size:11.5px;line-height:1.6;color:" + C.dim + ";margin-top:3px",
        c.kind.lead
      )
    );

    lab.appendChild(input);
    lab.appendChild(body);

    lab.addEventListener("click", function (e) {
      /* ラベルごと押せるようにする。二重発火は防ぐ。 */
      if (e.target !== input) {
        e.preventDefault();
        input.checked = true;
      }
      pick(c.kind.key);
    });
    return lab;
  }

  /** 選ばれた支払方法に切り替える。オプションはできるだけ持ち越す。 */
  function pick(key) {
    var cur = current();
    select(key, cur ? cur.op1 : false, cur ? cur.op2 : false);
  }

  /* 画面に出すオプション。行の登録がある分だけ出す。 */
  var OPTIONS = [
    {
      key: "op1",
      title: "OP① ジェルパッド1年分を追加する　＋13,200円",
      lead: "通常 年17,500円のところ 13,200円（税込）。今回のお支払いに一度だけ加算されます",
    },
    {
      key: "op2",
      title: "OP② 延長保証を追加する（メーカー保証1年 → 3年）　＋11,000円",
      lead: "一回のお支払いのみで、以降の追加費用はありません（税込）",
    },
  ];

  function optionBox(o) {
    var box = el(
      "div",
      "border:1px dashed " +
        C.gold +
        ";border-radius:8px;padding:13px 15px;background:rgba(201,169,106,.05)"
    );
    var lab = el("label", "display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:0");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.style.cssText = "margin:3px 0 0;flex:0 0 auto;accent-color:" + C.gold;
    var body = el("div", "flex:1 1 auto;min-width:0");
    body.appendChild(el("div", "font-size:14px;font-weight:700;color:" + C.text, o.title));
    body.appendChild(
      el("div", "font-size:11.5px;line-height:1.6;color:" + C.dim + ";margin-top:3px", o.lead)
    );
    lab.appendChild(input);
    lab.appendChild(body);
    box.appendChild(lab);

    lab.addEventListener("click", function (e) {
      if (e.target !== input) {
        e.preventDefault();
        input.checked = !input.checked;
      }
      var cur = current();
      if (!cur) return;
      var op1 = o.key === "op1" ? input.checked : cur.op1;
      var op2 = o.key === "op2" ? input.checked : cur.op2;
      select(cur.kind, op1, op2);
    });

    box._input = input;
    box._key = o.key;
    return box;
  }

  /** オプションの欄。支払方法の下に置く。 */
  function buildOptions(wrap) {
    if (wrap._opts) return wrap._opts;
    /* オプション付きの行が1つも無いページ（パッド買い足しなど）には出さない。 */
    var any = rowsInfo().some(function (x) {
      return x.op1 || x.op2;
    });
    if (!any) return null;

    var head2 = head("オプション（ご希望の方のみ）", false);
    head2.style.marginTop = "22px";
    var list = el("div", "display:flex;flex-direction:column;gap:8px");
    OPTIONS.forEach(function (o) {
      list.appendChild(optionBox(o));
    });
    wrap.appendChild(head2);
    wrap.appendChild(list);
    wrap._optsHead = head2;
    wrap._opts = list;
    return list;
  }

  /** いま UTAGE 側で選ばれている支払方法の種類。 */
  function currentKey() {
    var c = current();
    return c ? c.kind : null;
  }

  /** 購入商品の明細を足し合わせた、いま支払う総額。 */
  function totalYen() {
    var items = summaryLines();
    var sum = 0;
    items.forEach(function (i) {
      sum += i.price;
    });
    return sum;
  }

  /**
   * 確定ボタンのすぐ上にある「購入商品」に、お支払い合計の行を足す。
   * もとは VIS-TOTAL-ROW がやっていたのと同じ役目。
   * この表は表示用で、決済の値は持っていない（商品の選択とは別物）。
   */
  function paintSummary(sum) {
    var tb = document.querySelector("table.summary");
    if (!tb || !tb.tBodies.length || !sum) return;
    var body = tb.tBodies[0];
    var row = body.querySelector("tr.vis-total");
    if (!row) {
      row = document.createElement("tr");
      row.className = "vis-total";
      var a = document.createElement("td");
      a.textContent = "お支払い合計";
      a.style.cssText = "font-weight:700";
      var b = document.createElement("td");
      b.className = "text-right";
      b.style.cssText = "font-weight:700;white-space:nowrap";
      row.appendChild(a);
      row.appendChild(b);
      body.appendChild(row);
    }
    if (row.nextSibling) body.appendChild(row);
    var txt = comma(sum) + "円（税込）";
    if (row.cells[1].textContent !== txt) row.cells[1].textContent = txt;
  }

  function paint() {
    var wrap = document.getElementById(ID);
    if (!wrap) return;
    var cs = choices();
    if (!cs.length) return;

    /* 選択肢の顔ぶれが変わったときだけ作り直す（毎回作ると選択が飛ぶ）。 */
    var sig = cs
      .map(function (c) {
        return c.kind.key;
      })
      .join("|");
    if (wrap._rendered !== sig) {
      wrap._list.innerHTML = "";
      var cur = currentKey();
      cs.forEach(function (c) {
        wrap._list.appendChild(optionRow(c, c.kind.key === cur));
      });
      wrap._rendered = sig;
      /* 支払方法が1つしかないページでは、選ばせる意味がないので見出しごと隠す。 */
      var only = cs.length < 2;
      wrap._payHead.style.display = only ? "none" : "";
      wrap._list.style.display = only ? "none" : "";
    }

    var key = currentKey();

    /* 枠線とチェックを、UTAGE 側の実際の選択に合わせる。 */
    Array.prototype.forEach.call(
      wrap._list.querySelectorAll("label[data-vis-pay]"),
      function (lab) {
        var on = lab.getAttribute("data-vis-pay") === key;
        lab.style.borderColor = on ? C.gold : C.line;
        var input = lab.querySelector("input");
        if (input && input.checked !== on) input.checked = on;
      }
    );

    /* 選んだ方法の案内。クレジットは UTAGE のカード欄がそのまま出るので出さない。 */
    var kind = null;
    KINDS.forEach(function (k) {
      if (k.key === key) kind = k;
    });
    var text = kind && kind.note ? kind.note : "";
    if (text && key !== "card") {
      if (wrap._note.textContent !== text) wrap._note.textContent = text;
      wrap._note.style.display = "";
    } else {
      wrap._note.style.display = "none";
    }

    /* オプションのチェックを、UTAGE 側の実際の選択に合わせる。
       その支払方法に行が用意されていないオプションは、押せないように隠す。 */
    var opts = buildOptions(wrap);
    var cur2 = current();
    if (opts && cur2) {
      Array.prototype.forEach.call(opts.children, function (box) {
        var on = box._key === "op1" ? cur2.op1 : cur2.op2;
        var can =
          box._key === "op1"
            ? Boolean(findRow(cur2.kind, true, cur2.op2) || findRow(cur2.kind, true, false))
            : Boolean(findRow(cur2.kind, cur2.op1, true) || findRow(cur2.kind, false, true));
        box.style.display = can ? "" : "none";
        if (box._input.checked !== on) box._input.checked = on;
      });
      var anyVisible = Array.prototype.some.call(opts.children, function (box) {
        return box.style.display !== "none";
      });
      wrap._optsHead.style.display = anyVisible ? "" : "none";
      opts.style.display = anyVisible ? "" : "none";
    }

    paintSummary(totalYen());
  }

  function tick() {
    if (!document.querySelector('input[name="payment-method"]')) return;
    showSelectedRowOnly();
    injectStyle();
    stripMarkers();
    if (build()) paint();
  }

  /*
   * 支払方法を変えた直後は、UTAGE が「購入商品」の明細を作り直している途中で、
   * その場で読むと前の金額のままになる。少し間を置いて何度か見に行き、
   * 古い合計（OP①を足したままの額など）が画面に残らないようにする。
   */
  function repaintSoon() {
    paint();
    [120, 300, 600, 1000].forEach(function (ms) {
      setTimeout(paint, ms);
    });
  }

  document.addEventListener("change", function (e) {
    if (!e.target) return;
    if (e.target.name === "payment-method" || e.target.type === "checkbox") repaintSoon();
  });

  /* UTAGE は画面を作り直すことがあるので、様子を見ながら合わせ続ける。 */
  setInterval(tick, 500);
  tick();
})();
