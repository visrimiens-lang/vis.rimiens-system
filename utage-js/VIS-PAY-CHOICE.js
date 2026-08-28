/*
 * VIS-PAY-CHOICE : 支払方法を「商品の選択肢」から切り離して独立した項目にする
 * 2026-08-28
 *
 * ■ なぜ要るか
 *
 * UTAGE は「商品詳細（価格ラインナップ）」の行そのものがラジオボタンになる。
 * クレジット・銀行振込・アプラスを出すには同じ本体商品を3行ぶら下げるしかなく、
 * お客様には「同じ商品が3つ並んでいて、どれを選べばよいか分からない」画面になる。
 * 商品名の末尾に【銀行振込】【アプラス（ローン）】と書いて見分けている状態で、
 * 金額も3行とも 188,300円 なので、なおさら区別がつかない。
 *
 * そこで
 *   ・商品の欄には「何を買うか」だけを出す
 *   ・その下に「お支払い方法」という独立した項目を作る
 * という形に組み替える。選ばれたものに応じて、裏では対応する UTAGE の行を押す。
 * 決済の仕組みそのものは UTAGE のまま動く。
 *
 * ■ 触ってよい場所・いけない場所
 *
 * 商品行（table.payment-method の中）の文字は絶対に書き換えない。
 * 書き換えると UTAGE が行を作り直し、選んだ支払方法が先頭に戻る
 * （2026-08-27 に VIS-BUMP-TOTAL でこの不具合を出した）。
 * この表は丸ごと隠すだけにして、中身には一切触れない。
 * 金額は table.summary（購入商品の明細）から読む。こちらは UTAGE が
 * オーダーバンプまで含めて作ってくれるので、自前で足し算の前提を持たずに済む。
 *
 * ■ お支払い合計
 *
 * もとは VIS-TOTAL-ROW が同じ役目をしていたが、商品の表を隠したことで
 * 数字を拾えなくなった。合計の面倒はこのスクリプトが引き受けるので、
 * VIS-TOTAL-ROW は外すこと（残すと二重に行が出る）。
 *
 * ■ OP①（ジェルパッド1年分）について
 *
 * OP① はクレジットカード払いのオーダーバンプとして作られているので、
 * 銀行振込・アプラスを選ぶと UTAGE が自動で引っ込める。
 * 黙って消えると「さっきあったチェックが無くなった」と見えるので、
 * 消える代わりに理由を出す。
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

  /* 支払方法ごとの見せ方。UTAGE の行の文字から種類を判定する。 */
  var KINDS = [
    {
      key: "card",
      title: "クレジットカード",
      lead: "VISA / Mastercard / JCB / AMEX / Diners（一回払い）",
      note: null,
      match: function (t) {
        return !/アプラス|ローン|銀行振込|振込/.test(t);
      },
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
      match: function (t) {
        return /銀行振込|振込/.test(t) && !/アプラス|ローン/.test(t);
      },
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
      match: function (t) {
        return /アプラス|ローン/.test(t);
      },
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

  /** 支払方法の種類ごとに、対応する UTAGE の行を束ねる。 */
  function choices() {
    var rs = radios();
    var out = [];
    KINDS.forEach(function (k) {
      var hit = null;
      rs.forEach(function (r) {
        if (!hit && k.match(textOf(r))) hit = r;
      });
      if (hit) out.push({ kind: k, radio: hit });
    });
    return out;
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function hideOriginal() {
    var table = document.querySelector("table.payment-method");
    if (!table) return null;
    var group = table.closest(".form-group") || table.parentElement;
    /* 表示だけ消す。値も選択状態も UTAGE のまま残す（外すと決済が通らない）。 */
    if (group.style.display !== "none") group.style.display = "none";
    return group;
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
    var group = hideOriginal();
    if (!group) return null;

    var wrap = el("div", "margin:0 0 18px");
    wrap.id = ID;

    var itemBox = el(
      "div",
      "background:" +
        C.panel +
        ";border:1px solid " +
        C.line +
        ";border-radius:8px;padding:6px 16px 14px;margin-bottom:22px"
    );
    var lines = el("div", "");
    var total = el(
      "div",
      "margin-top:10px;padding-top:10px;border-top:1px solid " +
        C.line +
        ";display:flex;justify-content:space-between;align-items:baseline;gap:10px"
    );
    var totalLabel = el(
      "span",
      "font-size:13px;font-weight:700;color:" + C.text,
      "お支払い合計"
    );
    var totalValue = el(
      "span",
      "font-size:17px;font-weight:700;color:" + C.goldLight
    );
    total.appendChild(totalLabel);
    total.appendChild(totalValue);
    itemBox.appendChild(lines);
    itemBox.appendChild(total);

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

    wrap.appendChild(head("ご注文内容", false));
    wrap.appendChild(itemBox);
    wrap.appendChild(payHead);
    wrap.appendChild(list);
    wrap.appendChild(note);

    group.parentNode.insertBefore(wrap, group.nextSibling);

    wrap._lines = lines;
    wrap._totalValue = totalValue;
    wrap._payHead = payHead;
    wrap._list = list;
    wrap._note = note;
    wrap._rendered = "";
    wrap._linesKey = "";
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

  /** 選ばれた支払方法に対応する UTAGE の行を押す。 */
  function pick(key) {
    var cs = choices();
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].kind.key !== key) continue;
      if (!cs[i].radio.checked) cs[i].radio.click();
      break;
    }
    repaintSoon();
  }

  /** いま UTAGE 側で選ばれている支払方法の種類。 */
  function currentKey() {
    var r = document.querySelector('input[name="payment-method"]:checked');
    if (!r) return null;
    var t = textOf(r);
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].match(t)) return KINDS[i].key;
    }
    return null;
  }

  /* このページに OP① のバンプがあるか（パッド買い足しページには無い）。
     一度でも見えたら覚えておく。支払方法を変えると UTAGE が消してしまうため。 */
  var bumpSeen = false;
  function hasBumpProduct() {
    if (document.querySelector(".oredr-bunmp")) bumpSeen = true;
    return bumpSeen;
  }

  /** 明細と合計を描く。中身が変わったときだけ書き換える。 */
  function paintLines(wrap) {
    var items = summaryLines();
    if (!items.length) return 0;
    var sum = 0;
    items.forEach(function (i) {
      sum += i.price;
    });
    var key = items
      .map(function (i) {
        return i.name + ":" + i.price;
      })
      .join("|");
    if (wrap._linesKey !== key) {
      wrap._lines.innerHTML = "";
      items.forEach(function (i) {
        var row = el(
          "div",
          "display:flex;justify-content:space-between;align-items:baseline;gap:12px;" +
            "padding:8px 0;font-size:13.5px;line-height:1.7;color:" +
            C.text
        );
        row.appendChild(el("span", "flex:1 1 auto;min-width:0", i.name));
        row.appendChild(
          el(
            "span",
            "flex:0 0 auto;white-space:nowrap;color:" + C.dim,
            comma(i.price) + "円"
          )
        );
        wrap._lines.appendChild(row);
      });
      wrap._linesKey = key;
    }
    var txt = comma(sum) + "円（税込）";
    if (wrap._totalValue.textContent !== txt) wrap._totalValue.textContent = txt;
    return sum;
  }

  /**
   * 確定ボタンのすぐ上にある「購入商品」を、注文の最終確認として整える。
   *   ・商品名の【銀行振込】などの但し書きを外す
   *     （支払方法は独立した項目になったので、商品名に混ぜる意味がなくなった）
   *   ・お支払い方法の行を足す
   *   ・お支払い合計の行を足す
   * この表は UTAGE の表示用で、決済の値は持っていない。
   * 商品の選択（table.payment-method）とは別物なので、書き換えても選択は飛ばない。
   */
  function addRow(body, cls, label) {
    var row = body.querySelector("tr." + cls);
    if (row) return row;
    row = document.createElement("tr");
    row.className = cls;
    var a = document.createElement("td");
    a.textContent = label;
    a.style.cssText = "font-weight:700";
    var b = document.createElement("td");
    b.className = "text-right";
    b.style.cssText = "font-weight:700;white-space:nowrap";
    row.appendChild(a);
    row.appendChild(b);
    body.appendChild(row);
    return row;
  }

  function paintSummary(sum, kind) {
    var tb = document.querySelector("table.summary");
    if (!tb || !tb.tBodies.length || !sum) return;
    var body = tb.tBodies[0];

    /* 商品名から支払方法の但し書きを外す。 */
    Array.prototype.forEach.call(body.rows, function (r) {
      if (r.className.indexOf("vis-") === 0) return;
      if (!r.cells.length) return;
      var c = r.cells[0];
      var t = (c.innerText || c.textContent || "").trim();
      if (t.indexOf("【") < 0) return;
      var next = t.replace(/【[^】]*】/g, "").replace(/\s+$/, "");
      if (next && c.textContent !== next) c.textContent = next;
    });

    var payRow = addRow(body, "vis-pay-row", "お支払い方法");
    var payText = kind ? kind.title : "";
    if (payText && payRow.cells[1].textContent !== payText) {
      payRow.cells[1].textContent = payText;
    }
    payRow.style.display = payText ? "" : "none";

    /* 合計は必ずいちばん下に置く。 */
    var totalRow = addRow(body, "vis-total", "お支払い合計");
    if (totalRow.nextSibling) body.appendChild(totalRow);
    var txt = comma(sum) + "円（税込）";
    if (totalRow.cells[1].textContent !== txt) totalRow.cells[1].textContent = txt;
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
      if (hasBumpProduct()) {
        text +=
          "\n※ OP①（ジェルパッド1年分の追加）は、クレジットカード払いのみお選びいただけます。";
      }
      if (wrap._note.textContent !== text) wrap._note.textContent = text;
      wrap._note.style.display = "";
    } else {
      wrap._note.style.display = "none";
    }

    paintSummary(paintLines(wrap), kind);
  }

  function tick() {
    if (!document.querySelector('input[name="payment-method"]')) return;
    hideOriginal();
    hasBumpProduct();
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
