/* ============================================================
 * practice-core.js — 刷题引擎（专项刷题 / 错题练习 共用）
 * 负责「答题 → 实时判分 → 错题本统计 → 成绩保存」全流程。
 *
 * 页面只需提供「设置阶段」与 fetchQuestions()，并复用以下固定 DOM id：
 *   phase-doing / phase-done
 *   prog-text / prog-bar / prog-time
 *   q-head / q-stem / q-opts / q-analysis
 *   btn-next / btn-quit / done-score / done-sub
 *
 * 交互规则（覆盖三类题型）：
 *   - 选中：蓝色边框 + 「已选」标记
 *   - 确认：所有题型均需点「确认答案」按钮
 *   - 确认后：正确选项绿色 + 前置 ✓；错误/未选选项后置 ✗；自己选错的选项红色边框
 *   - 提示框：答对绿框、答错红框；答错时「正确答案」大号加粗、「你的答案」小号不加粗
 * ============================================================ */
const PracticeCore = (function () {
  function create(config) {
    const state = {
      questions: [], index: 0, details: [],
      locked: false, startTime: 0, timer: null
    };
    const $ = (id) => document.getElementById(id);

    function tick() {
      $('prog-time').textContent = fmtTime(Math.floor((Date.now() - state.startTime) / 1000));
    }

    function start() {
      return Promise.resolve(config.fetchQuestions())
        .then((qs) => {
          if (!qs || !qs.length) { toast('没有可练习的题目', 'err'); return; }
          state.questions = qs; state.index = 0; state.details = [];
          state.startTime = Date.now();
          $('phase-doing').style.display = '';
          $('phase-done').style.display = 'none';
          state.timer = setInterval(tick, 1000);
          renderQuestion();
        })
        .catch((e) => toast(e.message || '加载题目失败', 'err'));
    }

    function letterOf(q, i) {
      return q.type === 'judge' ? (i === 0 ? 'T' : 'F') : String.fromCharCode(65 + i);
    }

    function selectedLetters(q) {
      const sel = [...$('q-opts').querySelectorAll('.opt.selected')].map((b) => b.dataset.letter);
      return q.type === 'multiple' ? sel.sort().join('') : (sel[0] || '');
    }

    function renderQuestion() {
      const q = state.questions[state.index];
      state.locked = false;
      $('q-analysis').innerHTML = '';
      $('btn-next').style.display = 'none';
      $('prog-text').textContent = `第 ${state.index + 1} / ${state.questions.length} 题`;
      $('prog-bar').style.width = `${(state.index / state.questions.length) * 100}%`;
      $('q-head').innerHTML =
        `<span class="tag tag-blue">${TYPE_NAME[q.type]}</span>` +
        (q.type === 'multiple'
          ? `<span class="tag tag-orange">多选题 · 选多个后点确认</span>`
          : `<span class="tag tag-orange">选择一项后点确认</span>`);
      $('q-stem').textContent = q.stem;

      const box = $('q-opts');
      const optsHtml = q.options.map((o, i) => {
        const letter = letterOf(q, i);
        const letterHtml = q.type === 'judge' ? '' : `<span class="letter">${letter}</span>`;
        return `<button class="opt" data-i="${i}" data-letter="${letter}">
                  <span class="mark mark-pre"></span>${letterHtml}
                  <span class="opt-text">${esc(o)}</span>
                  <span class="mark mark-post"></span>
                </button>`;
      }).join('') +
        `<div class="opt-footer flex right mt8">
           <span class="sel-hint" id="sel-hint"></span>
           <button class="btn" id="btn-confirm" disabled>确认答案</button>
         </div>`;
      box.innerHTML = optsHtml;
      box.querySelectorAll('.opt').forEach((b) => { b.onclick = () => onSelect(q, b); });
      $('btn-confirm').onclick = () => onConfirm(q);
      updateConfirm(q);
    }

    function onSelect(q, btn) {
      if (state.locked) return;
      if (q.type === 'multiple') {
        btn.classList.toggle('selected');
      } else {
        $('q-opts').querySelectorAll('.opt').forEach((x) => x.classList.remove('selected'));
        btn.classList.add('selected');
      }
      updateConfirm(q);
    }

    function updateConfirm(q) {
      const sel = selectedLetters(q);
      const hint = $('sel-hint');
      const btn = $('btn-confirm');
      if (q.type === 'multiple') {
        btn.disabled = sel.length < 1;
        hint.textContent = sel ? `已选 ${sel.split('').join('、')}` : '请选择（可多选）';
      } else {
        btn.disabled = sel.length !== 1;
        hint.textContent = sel ? `已选 ${sel}` : '请选择一个选项';
      }
    }

    async function onConfirm(q) {
      if (state.locked) return;
      const sel = selectedLetters(q);
      if (!sel) { toast('请先选择答案', 'err'); return; }
      if (q.type === 'multiple' && sel.length < 2) { toast('多选题至少选择两个答案', 'err'); return; }
      await doCheck(q, sel);
    }

    async function doCheck(q, answer) {
      state.locked = true;
      state.details.push({ questionId: q.id, userAnswer: answer });
      let r;
      try {
        r = await postJSON('/api/practice/check', { questionId: q.id, answer });
      } catch (e) {
        toast(e.message, 'err');
        state.locked = false;
        return;
      }
      markOptions(q, answer, r.correctAnswer);
      showFeedback(answer, r);
      $('q-opts').querySelectorAll('.opt').forEach((b) => { b.classList.add('disabled'); b.onclick = null; });
      $('btn-confirm').disabled = true;
      const next = $('btn-next');
      next.style.display = '';
      next.textContent = state.index === state.questions.length - 1 ? '完成练习 ✓' : '下一题 →';
    }

    /** 确认后高亮：正确绿✓ / 错误红✗ / 未选也标 ✗ */
    function markOptions(q, userAnswer, correctAnswer) {
      const opts = $('q-opts').querySelectorAll('.opt');
      const correctLetters = q.type === 'judge'
        ? [correctAnswer === 'T' ? 'T' : 'F']
        : [...correctAnswer];
      const userLetters = [...userAnswer];
      opts.forEach((b) => {
        const letter = b.dataset.letter;
        if (correctLetters.includes(letter)) {
          b.classList.add('correct');
        } else {
          b.classList.add('reveal-x');                 // 后置 ✗（未选的 / 错误的）
          if (userLetters.includes(letter)) b.classList.add('wrong'); // 自己选错的 → 红框
        }
      });
    }

    function showFeedback(userAnswer, r) {
      const an = $('q-analysis');
      if (r.correct) {
        an.innerHTML = `<div class="analysis ok enhanced">
          <div class="result-title">✓ 回答正确</div>
          <div class="analysis-text">${esc(r.analysis || '暂无解析')}</div>
        </div>`;
      } else {
        an.innerHTML = `<div class="analysis bad enhanced">
          <div class="result-title">✗ 回答错误</div>
          <div class="answer-reveal">
            <span class="ans-label">正确答案：</span><b class="ans-correct">${esc(fmtAnswer(r.correctAnswer))}</b>
            <span class="ans-yours">你的答案：${esc(fmtAnswer(userAnswer))}</span>
          </div>
          <div class="analysis-text">${esc(r.analysis || '暂无解析')}</div>
        </div>`;
      }
    }

    async function finish() {
      if (state.timer) clearInterval(state.timer);
      const durationSec = Math.round((Date.now() - state.startTime) / 1000);
      $('phase-doing').style.display = 'none';
      try {
        const r = await postJSON('/api/practice/finish', {
          category: config.category || '专项刷题', durationSec, details: state.details
        });
        $('done-score').textContent = r.score + ' 分';
        $('done-sub').textContent =
          `共 ${r.total} 题，答对 ${r.correctCount} 题，用时 ${fmtTime(durationSec)}，成绩已保存`;
      } catch (e) {
        $('done-score').textContent = '--';
        $('done-sub').textContent = '成绩保存失败：' + e.message;
      }
      $('phase-done').style.display = '';
      window.scrollTo(0, 0);
    }

    $('btn-next').onclick = () => {
      if (state.index < state.questions.length - 1) { state.index++; renderQuestion(); }
      else finish();
    };
    $('btn-quit').onclick = () => {
      if (!state.details.length) { location.reload(); return; }
      if (confirm('提前结束练习？已作答的题目将计入成绩。')) finish();
    };

    return { start };
  }
  return { create };
})();
