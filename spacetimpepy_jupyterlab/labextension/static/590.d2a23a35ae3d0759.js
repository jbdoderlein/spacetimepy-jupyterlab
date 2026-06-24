"use strict";(self.rspackChunkspacetimpepy_jupyterlab=self.rspackChunkspacetimpepy_jupyterlab||[]).push([[590],{8509(e,t,n){n.r(t);var o=n(277),r=n(8705),a=n(4207),s=n(1660);n(8665);let i="spacetimpepy-jupyterlab:open-panel";class l extends s.Widget{constructor(e){super(),this.id="spacetimpepy-explorer-panel",this.title.label="Explore",this.title.caption="Exploratory notebook controls",this.addClass("spx-panel");const t=document.createElement("div");t.className="spx-panel-header",t.textContent="Exploratory Controls";const n=document.createElement("button");n.className="spx-button",n.type="button",n.textContent="Highlight Active Line",n.onclick=()=>{e.onHighlightLine(),this.setStatus("Requested notebook highlight.")};const o=document.createElement("button");o.className="spx-button",o.type="button",o.textContent="Kernel Probe",o.onclick=async()=>{this.setStatus("Waiting for kernel...");let t=await e.onKernelProbe();this.setStatus(t)},this.status=document.createElement("pre"),this.status.className="spx-status",this.status.textContent="Open a notebook and use the buttons above.",this.node.append(t,n,o,this.status)}setStatus(e){this.status.textContent=e}}async function c(e){var t,n;let o=null==(n=null==(t=e.currentWidget)?void 0:t.sessionContext.session)?void 0:n.kernel;if(!o)return"No active notebook kernel.";let r=o.requestExecute({code:"print('spacetimpepy kernel probe ok')",silent:!1,stop_on_error:!0,store_history:!1}),s=[];r.onIOPub=e=>{if(a.KernelMessage.isStreamMsg(e))s.push(e.content.text);else if(a.KernelMessage.isExecuteResultMsg(e)){let t=e.content.data["text/plain"];"string"==typeof t&&s.push(t)}else a.KernelMessage.isErrorMsg(e)&&s.push(e.content.traceback.join("\n"))};try{await r.done}catch(e){return`Kernel probe failed: ${String(e)}`}return s.join("").trim()||"Kernel probe completed."}let p={id:"spacetimpepy-jupyterlab:plugin",autoStart:!0,requires:[r.INotebookTracker],optional:[o.ICommandPalette],activate:(e,t,n)=>{let o=new l({onHighlightLine:()=>(function(e){var t,n;let o=null==(t=e.currentWidget)?void 0:t.content.activeCell;if(!o)return;let r=null!=(n=o.node.querySelector(".cm-line"))?n:o.node.querySelector(".jp-InputArea-editor");r&&(r.classList.add("spx-line-highlight"),window.setTimeout(()=>{r.classList.remove("spx-line-highlight")},1600))})(t),onKernelProbe:()=>c(t)});e.shell.add(o,"left",{rank:650}),e.commands.addCommand(i,{label:"Open Exploratory Controls",execute:()=>{o.isAttached||e.shell.add(o,"left",{rank:650}),e.shell.activateById(o.id)}}),null==n||n.addItem({command:i,category:"Notebook Tools"})}};n.d(t,{},{default:p})},2646(e,t,n){var o=n(1601),r=n.n(o),a=n(6314),s=n.n(a)()(r());s.push([e.id,`.spx-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  padding: 12px;
  color: var(--jp-ui-font-color1);
  background: var(--jp-layout-color1);
  font-family: var(--jp-ui-font-family);
}

.spx-panel-header {
  font-size: var(--jp-ui-font-size2);
  font-weight: 600;
}

.spx-button {
  box-sizing: border-box;
  width: 100%;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  color: var(--jp-ui-font-color1);
  background: var(--jp-layout-color2);
  cursor: pointer;
  text-align: left;
}

.spx-button:hover {
  background: var(--jp-layout-color3);
}

.spx-status {
  min-height: 72px;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--jp-border-color2);
  border-radius: 4px;
  overflow: auto;
  color: var(--jp-ui-font-color2);
  background: var(--jp-layout-color0);
  font-family: var(--jp-code-font-family);
  font-size: var(--jp-code-font-size);
  white-space: pre-wrap;
}

.spx-line-highlight {
  outline: 2px solid var(--jp-brand-color1);
  background: color-mix(in srgb, var(--jp-brand-color1) 18%, transparent);
  transition: background 160ms ease-out;
}
`,""]),n.d(t,{},{A:s})},6314(e){e.exports=function(e){var t=[];return t.toString=function(){return this.map(function(t){var n="",o=void 0!==t[5];return t[4]&&(n+="@supports (".concat(t[4],") {")),t[2]&&(n+="@media ".concat(t[2]," {")),o&&(n+="@layer".concat(t[5].length>0?" ".concat(t[5]):""," {")),n+=e(t),o&&(n+="}"),t[2]&&(n+="}"),t[4]&&(n+="}"),n}).join("")},t.i=function(e,n,o,r,a){"string"==typeof e&&(e=[[null,e,void 0]]);var s={};if(o)for(var i=0;i<this.length;i++){var l=this[i][0];null!=l&&(s[l]=!0)}for(var c=0;c<e.length;c++){var p=[].concat(e[c]);o&&s[p[0]]||(void 0!==a&&(void 0===p[5]||(p[1]="@layer".concat(p[5].length>0?" ".concat(p[5]):""," {").concat(p[1],"}")),p[5]=a),n&&(p[2]&&(p[1]="@media ".concat(p[2]," {").concat(p[1],"}")),p[2]=n),r&&(p[4]?(p[1]="@supports (".concat(p[4],") {").concat(p[1],"}"),p[4]=r):p[4]="".concat(r)),t.push(p))}},t}},1601(e){e.exports=function(e){return e[1]}},8665(e,t,n){n.r(t);var o=n(5072),r=n.n(o),a=n(7825),s=n.n(a),i=n(7659),l=n.n(i),c=n(5056),p=n.n(c),u=n(540),d=n.n(u),f=n(1113),h=n.n(f),m=n(2646),v={};v.styleTagTransform=h(),v.setAttributes=p(),v.insert=l().bind(null,"head"),v.domAPI=s(),v.insertStyleElement=d(),r()(m.A,v);let b=m.A&&m.A.locals?m.A.locals:void 0;n.d(t,{},{default:b})},5072(e){var t=[];function n(e){for(var n=-1,o=0;o<t.length;o++)if(t[o].identifier===e){n=o;break}return n}function o(e,o){for(var r={},a=[],s=0;s<e.length;s++){var i=e[s],l=o.base?i[0]+o.base:i[0],c=r[l]||0,p="".concat(l," ").concat(c);r[l]=c+1;var u=n(p),d={css:i[1],media:i[2],sourceMap:i[3],supports:i[4],layer:i[5]};if(-1!==u)t[u].references++,t[u].updater(d);else{var f=function(e,t){var n=t.domAPI(t);return n.update(e),function(t){t?(t.css!==e.css||t.media!==e.media||t.sourceMap!==e.sourceMap||t.supports!==e.supports||t.layer!==e.layer)&&n.update(e=t):n.remove()}}(d,o);o.byIndex=s,t.splice(s,0,{identifier:p,updater:f,references:1})}a.push(p)}return a}e.exports=function(e,r){var a=o(e=e||[],r=r||{});return function(e){e=e||[];for(var s=0;s<a.length;s++){var i=n(a[s]);t[i].references--}for(var l=o(e,r),c=0;c<a.length;c++){var p=n(a[c]);0===t[p].references&&(t[p].updater(),t.splice(p,1))}a=l}}},7659(e){var t={};e.exports=function(e,n){var o=function(e){if(void 0===t[e]){var n=document.querySelector(e);if(window.HTMLIFrameElement&&n instanceof window.HTMLIFrameElement)try{n=n.contentDocument.head}catch(e){n=null}t[e]=n}return t[e]}(e);if(!o)throw Error("Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.");o.appendChild(n)}},540(e){e.exports=function(e){var t=document.createElement("style");return e.setAttributes(t,e.attributes),e.insert(t,e.options),t}},5056(e,t,n){e.exports=function(e){var t=n.nc;t&&e.setAttribute("nonce",t)}},7825(e){e.exports=function(e){if("u"<typeof document)return{update:function(){},remove:function(){}};var t=e.insertStyleElement(e);return{update:function(n){var o,r,a;o="",n.supports&&(o+="@supports (".concat(n.supports,") {")),n.media&&(o+="@media ".concat(n.media," {")),(r=void 0!==n.layer)&&(o+="@layer".concat(n.layer.length>0?" ".concat(n.layer):""," {")),o+=n.css,r&&(o+="}"),n.media&&(o+="}"),n.supports&&(o+="}"),(a=n.sourceMap)&&"u">typeof btoa&&(o+="\n/*# sourceMappingURL=data:application/json;base64,".concat(btoa(unescape(encodeURIComponent(JSON.stringify(a))))," */")),e.styleTagTransform(o,t,e.options)},remove:function(){var e;null===(e=t).parentNode||e.parentNode.removeChild(e)}}}},1113(e){e.exports=function(e,t){if(t.styleSheet)t.styleSheet.cssText=e;else{for(;t.firstChild;)t.removeChild(t.firstChild);t.appendChild(document.createTextNode(e))}}}}]);