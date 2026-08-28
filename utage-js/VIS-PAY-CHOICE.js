/*
 * VIS-PAY-CHOICE : 商品の欄の下に「お支払い方法」の項目を足す
 * 2026-08-28
 *
 * ■ なぜ要るか
 *
 * UTAGE は「商品詳細（価格ラインナップ）」の行がそのままラジオボタンになる。
 * クレジット・銀行振込・アプラスを出すには同じ本体商品を3行ぶら下げるしかなく、
 * お客様には「同じ商品が3つ並んでいて、どれを選べばよいか分からない」画面になる。
 * 金額も3行とも 188,300円 で、末尾の【銀行振込】だけが違うので、なおさら分かりにくい。
 *
 * そこで
 *   ・商品の欄は、いま選ばれている1行だけを出す（もとの見た目と同じ）
 *   ・その下に「お支払い方法」という独立した項目を足す
 * という形にする。選ばれたものに応じて、裏では対応する UTAGE の行を押す。
 * 商品・OP①・OP② の見せ方はもとのまま。決済の仕組みも UTAGE のまま動く。
 *
 * ■ 触ってよい場所・いけない場所
 *
 * 商品行（table.payment-method の中）の文字は絶対に書き換えない。
 * 書き換えると UTAGE が行を作り直し、選んだ支払方法が先頭に戻る
 * （2026-08-27 に VIS-BUMP-TOTAL でこの不具合を出した）。
 * ここでやるのは、選ばれていない行を display:none にすることだけ。
 *
 * ■ お支払い合計
 *
 * もとは VIS-TOTAL-ROW が「購入商品」の下に合計を足していた。同じ役目を
 * このスクリプトが引き受けるので、VIS-TOTAL-ROW は外すこと（残すと二重に出る）。
 *
 * ■ OP① について
 *
 * OP① はクレジットカード払いのオーダーバンプなので、銀行振込・アプラスを
 * 選ぶと UTAGE が自動で引っ込める。黙って消えると
 * 「さっきあったチェックが無くなった」と見えるので、消える代わりに理由を出す。
 *
 * ■ OP②（延長保証）について
 *
 * UTAGE のオーダーバンプは1つの決済フォームに1つしか出せない。OP① で
 * 埋まっているので、OP② は「本体＋OP②」の商品行に差し替えることで足す
 * （もともと vis-op2 がやっていたのと同じやり方）。
 * 差し替え先はクレジットカード払いの行しか無いので、OP② もクレジットの
 * ときだけ出す。行の中の文字には触らず、行を押すだけ。
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

  /** 「本体＋OP②（３年延長保証）」の行。無いページでは null。 */
  function op2Radio() {
    var hit = null;
    radios().forEach(function (r) {
      if (!hit && /OP②|３年延長保証|3年延長保証/.test(textOf(r))) hit = r;
    });
    return hit;
  }

  /** OP② を付けずに買うときの、クレジットカード払いの行。 */
  function cardRadio() {
    var op2 = op2Radio();
    var hit = null;
    radios().forEach(function (r) {
      if (hit || r === op2) return;
      if (KINDS[0].match(textOf(r))) hit = r;
    });
    return hit;
  }

  function op2On() {
    var r = op2Radio();
    return Boolean(r && r.checked);
  }

  /** 選ばれた支払方法に対応する UTAGE の行を押す。 */
  function pick(key) {
    /* クレジットのままOP②を付けているときに、もう一度クレジットを押しても外れないように。 */
    if (key === "card" && op2On()) {
      repaintSoon();
      return;
    }
    var cs = choices();
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].kind.key !== key) continue;
      if (!cs[i].radio.checked) cs[i].radio.click();
      break;
    }
    repaintSoon();
  }

  /**
   * OP②（延長保証）のチェック欄。
   * OP①のバンプのすぐ下に置いて、2つのオプションが並んで見えるようにする。
   * バンプは支払方法を変えると UTAGE が消して作り直すので、
   * 置き場所が無くなっていないかを毎回みて、必要なら置き直す。
   */
  function buildOp2(wrap) {
    if (!op2Radio()) return null;
    if (wrap._op2) {
      var anchor0 = document.querySelector(".oredr-bunmp");
      if (anchor0 && wrap._op2.previousSibling !== anchor0) {
        anchor0.parentNode.insertBefore(wrap._op2, anchor0.nextSibling);
      }
      return wrap._op2;
    }

    var box = el(
      "div",
      "display:none;margin-top:12px;border:1px dashed " +
        C.gold +
        ";border-radius:8px;padding:13px 15px;background:rgba(201,169,106,.05)"
    );
    var lab = el("label", "display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:0");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.style.cssText = "margin:3px 0 0;flex:0 0 auto;accent-color:" + C.gold;
    var body = el("div", "flex:1 1 auto;min-width:0");
    body.appendChild(
      el(
        "div",
        "font-size:14px;font-weight:700;color:" + C.text,
        "OP② 延長保証を追加する（メーカー保証1年 → 3年）　＋11,000円"
      )
    );
    body.appendChild(
      el(
        "div",
        "font-size:11.5px;line-height:1.6;color:" + C.dim + ";margin-top:3px",
        "一回のお支払いのみで、以降の追加費用はありません（税込）"
      )
    );
    lab.appendChild(input);
    lab.appendChild(body);
    box.appendChild(lab);

    lab.addEventListener("click", function (e) {
      if (e.target !== input) {
        e.preventDefault();
        input.checked = !input.checked;
      }
      var want = input.checked;
      var target = want ? op2Radio() : cardRadio();
      if (target && !target.checked) target.click();
      repaintSoon();
    });

    var anchor = document.querySelector(".oredr-bunmp");
    if (anchor) {
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
    } else {
      wrap.appendChild(box);
    }
    wrap._op2 = box;
    wrap._op2Input = input;
    return box;
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

  /*
   * このページにあるオーダーバンプ（OP①・OP②）の名前を覚えておく。
   * 支払方法を銀行振込・アプラスに変えると UTAGE がバンプごと消すので、
   * そのときに「何が選べなくなったのか」を名前で書けるようにしておく。
   * パッド買い足しのページにはバンプが無いので、その場合は何も出さない。
   */
  var bumpNames = [];
  var bumpFound = false;
  function noteBumps() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".oredr-bunmp"),
      function (box) {
        bumpFound = true;
        var t = (box.innerText || box.textContent || "").replace(/\s+/g, " ");
        /* 「OP① ジェルパッド1年分を追加する」のような、チェック欄の見出しから名前を取る。
           箱の冒頭の煽り文（「注文をアップグレードします」など）は拾わない。 */
        var m = t.match(/OP[①②][^＋+。\n]{0,20}/g);
        if (!m) return;
        m.forEach(function (x) {
          var key = x.replace(/を追加する.*$/, "").trim();
          if (key && bumpNames.indexOf(key) < 0) bumpNames.push(key);
        });
      }
    );
    return bumpFound;
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
      if (noteBumps()) {
        text +=
          "\n※ " +
          (bumpNames.length ? bumpNames.join("・") : "オプション") +
          "の追加は、クレジットカード払いのみお選びいただけます。";
      }
      if (wrap._note.textContent !== text) wrap._note.textContent = text;
      wrap._note.style.display = "";
    } else {
      wrap._note.style.display = "none";
    }

    /* OP② はクレジットカード払いの行にしか無いので、クレジットのときだけ出す。 */
    var op2 = buildOp2(wrap);
    if (op2) {
      var show = key === "card";
      op2.style.display = show ? "" : "none";
      if (wrap._op2Input.checked !== op2On()) wrap._op2Input.checked = op2On();
    }

    paintSummary(totalYen());
  }

  function tick() {
    if (!document.querySelector('input[name="payment-method"]')) return;
    showSelectedRowOnly();
    noteBumps();
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
