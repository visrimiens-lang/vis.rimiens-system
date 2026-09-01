/* VIS-REF-CLAIM : QRの ?ref= を受注に結び付ける (2026-08-21)
 *
 * ■ 何のためか
 *
 * 代理店のQRは …/p/fXEUN6pjHMRW?ref=MENO0001 の形で配っている。
 * ところが UTAGE は、この ?ref= を決済完了の通知（Webhook）に載せてくれない。
 * 実際に届く内容のキーは9個だけで ref が無く、そのため
 * 5〜8月の実受注7件は「誰の売上か」が空のまま入り、報酬が1円も立っていない。
 *
 * このページは ?ref= を読めているので（すぐ下の VIS-QR-GATE が使っている）、
 * お客様が連絡先を入れた時点で「このメールアドレスの方はこのコードから来た」
 * という控えをポータルへ送っておく。決済の通知が届いたときに、
 * ポータル側がメールアドレス（無ければ電話番号）で突き合わせて付け先を決める。
 *
 * ■ 置き場所
 *
 * UTAGE 管理画面 → ファネル FZtfiFUmSxnL → ページ 5HiCWV8sHAnE →
 * カスタムJS（js_body）の末尾に、この中身をそのまま貼り足す。
 * 既存の VIS-CHECKBOX-SIZE / VIS-TOTAL-ROW / VIS-BUMP-TOTAL /
 * VIS-NAME-HINT / VIS-QR-GATE は消さないこと。
 *
 * ■ 安全のための決まり
 *
 * ・送るのは「コード・メールアドレス・電話番号」だけ。氏名や住所は送らない。
 * ・同じ内容を何度も送らない（連絡先が変わったときだけ送り直す）。
 * ・送信に失敗しても決済は止めない。
 * ・ポータル側は、実在する代理店コードでなければ控えを捨てる。
 */
(function () {
  var ref = new URLSearchParams(location.search).get("ref");
  if (!ref) return;

  var ENDPOINT = "https://vis-rimiens-system.vercel.app/api/ref-claim";
  var sent = "";

  /** 入力欄の中から、それらしい値を1つ拾う。 */
  function valueOf(patterns) {
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.type === "hidden" || el.disabled) continue;
      var hay = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
        .join(" ")
        .toLowerCase();
      for (var j = 0; j < patterns.length; j++) {
        if (hay.indexOf(patterns[j]) !== -1) {
          var v = (el.value || "").trim();
          if (v) return v;
        }
      }
    }
    // 名前で見つからないときは、形で拾う（メールアドレスだけ）
    for (var k = 0; k < inputs.length; k++) {
      if (inputs[k].type === "email") {
        var ev = (inputs[k].value || "").trim();
        if (ev) return ev;
      }
    }
    return "";
  }

  /*
   * 形の壊れた値は送らない（2026-09-01）。
   * 入力の途中で控えが飛ぶため、「1006」のような打ちかけの電話番号が
   * 保存されていた。中途半端な控えは突き合わせの事故のもとになるので、
   * メールは @ と . を含むもの、電話は数字10〜11桁になったものだけ送る。
   */
  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
  }
  function validPhone(v) {
    var d = (v || "").replace(/[^0-9]/g, "");
    return /^0\d{9,10}$/.test(d) ? d : "";
  }

  function claim() {
    var email = validEmail(valueOf(["email", "mail", "メール"]));
    var phone = validPhone(valueOf(["tel", "phone", "電話"]));
    if (!email && !phone) return;

    var key = ref + "|" + email + "|" + phone;
    if (key === sent) return; // 同じ内容は送り直さない
    sent = key;

    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: ref, email: email, phone: phone }),
        keepalive: true,
      }).catch(function () { /* 決済は止めない */ });
    } catch (e) { /* 決済は止めない */ }
  }

  // 入力が一段落したところで控える
  var timer = null;
  document.addEventListener(
    "input",
    function () {
      clearTimeout(timer);
      timer = setTimeout(claim, 800);
    },
    true
  );
  /*
   * 送信の直前に、建物欄へ「 #REF=コード」を書き足す（2026-09-01）。
   *
   * UTAGE の通知は ?ref= を載せないが、建物欄はそのまま載せる。
   * 同じ決済の通知に載って届けば、連絡先の突き合わせ（上の控え）が
   * 要らなくなり、別のスタッフに付く取り違えが起きない。
   * ポータル側（/api/webhooks/order）が目印を読み取ってから取り除くので、
   * 受注に残る建物名は元のまま。控えは目印が読めなかったときの保険として残す。
   */
  function markBuilding() {
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.type === "hidden" || el.disabled) continue;
      var hay = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
        .join(" ")
        .toLowerCase();
      if (/building|建物|マンション|部屋番号/.test(hay)) {
        // 入力し直しで二重に付かないよう、古い目印は消してから付ける
        var base = (el.value || "").replace(/\s*#REF=[A-Za-z0-9-]+\s*$/i, "");
        el.value = base + " #REF=" + ref;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
  }

  function beforeSubmit() {
    markBuilding();
    claim();
  }

  // 送信ボタンを押した瞬間にも、念のためもう一度
  document.addEventListener("submit", beforeSubmit, true);
  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      if (!t) return;
      var tag = (t.tagName || "").toLowerCase();
      if (tag === "button" || (tag === "input" && t.type === "submit")) beforeSubmit();
    },
    true
  );
})();
