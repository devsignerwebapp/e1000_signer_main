import { env } from '../config/env.js';

// GET /embed.js — drop-in widget that opens a template's signing page in an iframe modal.
// <script src="http://localhost:4000/embed.js"></script>
// <button onclick="E1000Signer.open('SHARE_TOKEN', { onSigned: (s) => console.log(s) })">Sign</button>
export function embedScript(_req, res) {
  res.type('application/javascript').send(`/* E1000Signer embed v1 */
(function(){
  var ORIGIN = ${JSON.stringify(env.webPublicUrl)};
  function open(token, opts){
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,21,53,.45);backdrop-filter:blur(4px);z-index:2147483646;display:flex;align-items:center;justify-content:center';
    var frame = document.createElement('iframe');
    frame.src = ORIGIN + '/sign/' + encodeURIComponent(token) + '?embed=1';
    frame.style.cssText = 'width:min(1100px,96vw);height:min(860px,94vh);border:0;border-radius:18px;background:#fff;box-shadow:0 30px 80px rgba(0,0,0,.25)';
    frame.allow = 'clipboard-write';
    overlay.appendChild(frame);
    function close(){ window.removeEventListener('message', onMsg); overlay.remove(); opts.onClose && opts.onClose(); }
    function onMsg(e){
      if (e.origin !== ORIGIN || !e.data || e.data.source !== 'e1000signer') return;
      if (e.data.type === 'signed') { opts.onSigned && opts.onSigned(e.data.submission); if (opts.closeOnSigned !== false) setTimeout(close, 1200); }
      if (e.data.type === 'close') close();
    }
    window.addEventListener('message', onMsg);
    overlay.addEventListener('click', function(e){ if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    return { close: close };
  }
  window.E1000Signer = { open: open };
})();`);
}
