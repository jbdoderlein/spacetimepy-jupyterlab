"use strict";(self.rspackChunkspacetimpepy_jupyterlab=self.rspackChunkspacetimpepy_jupyterlab||[]).push([[266],{2646(e,r,t){var o=t(1601),n=t.n(o),a=t(6314),i=t.n(a)()(n());i.push([e.id,`.spx-panel {
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
`,""]),t.d(r,{},{A:i})},6314(e){e.exports=function(e){var r=[];return r.toString=function(){return this.map(function(r){var t="",o=void 0!==r[5];return r[4]&&(t+="@supports (".concat(r[4],") {")),r[2]&&(t+="@media ".concat(r[2]," {")),o&&(t+="@layer".concat(r[5].length>0?" ".concat(r[5]):""," {")),t+=e(r),o&&(t+="}"),r[2]&&(t+="}"),r[4]&&(t+="}"),t}).join("")},r.i=function(e,t,o,n,a){"string"==typeof e&&(e=[[null,e,void 0]]);var i={};if(o)for(var c=0;c<this.length;c++){var s=this[c][0];null!=s&&(i[s]=!0)}for(var p=0;p<e.length;p++){var u=[].concat(e[p]);o&&i[u[0]]||(void 0!==a&&(void 0===u[5]||(u[1]="@layer".concat(u[5].length>0?" ".concat(u[5]):""," {").concat(u[1],"}")),u[5]=a),t&&(u[2]&&(u[1]="@media ".concat(u[2]," {").concat(u[1],"}")),u[2]=t),n&&(u[4]?(u[1]="@supports (".concat(u[4],") {").concat(u[1],"}"),u[4]=n):u[4]="".concat(n)),r.push(u))}},r}},1601(e){e.exports=function(e){return e[1]}},8665(e,r,t){t.r(r);var o=t(5072),n=t.n(o),a=t(7825),i=t.n(a),c=t(7659),s=t.n(c),p=t(5056),u=t.n(p),l=t(540),d=t.n(l),f=t(1113),v=t.n(f),h=t(2646),m={};m.styleTagTransform=v(),m.setAttributes=u(),m.insert=s().bind(null,"head"),m.domAPI=i(),m.insertStyleElement=d(),n()(h.A,m);let b=h.A&&h.A.locals?h.A.locals:void 0;t.d(r,{},{default:b})},5072(e){var r=[];function t(e){for(var t=-1,o=0;o<r.length;o++)if(r[o].identifier===e){t=o;break}return t}function o(e,o){for(var n={},a=[],i=0;i<e.length;i++){var c=e[i],s=o.base?c[0]+o.base:c[0],p=n[s]||0,u="".concat(s," ").concat(p);n[s]=p+1;var l=t(u),d={css:c[1],media:c[2],sourceMap:c[3],supports:c[4],layer:c[5]};if(-1!==l)r[l].references++,r[l].updater(d);else{var f=function(e,r){var t=r.domAPI(r);return t.update(e),function(r){r?(r.css!==e.css||r.media!==e.media||r.sourceMap!==e.sourceMap||r.supports!==e.supports||r.layer!==e.layer)&&t.update(e=r):t.remove()}}(d,o);o.byIndex=i,r.splice(i,0,{identifier:u,updater:f,references:1})}a.push(u)}return a}e.exports=function(e,n){var a=o(e=e||[],n=n||{});return function(e){e=e||[];for(var i=0;i<a.length;i++){var c=t(a[i]);r[c].references--}for(var s=o(e,n),p=0;p<a.length;p++){var u=t(a[p]);0===r[u].references&&(r[u].updater(),r.splice(u,1))}a=s}}},7659(e){var r={};e.exports=function(e,t){var o=function(e){if(void 0===r[e]){var t=document.querySelector(e);if(window.HTMLIFrameElement&&t instanceof window.HTMLIFrameElement)try{t=t.contentDocument.head}catch(e){t=null}r[e]=t}return r[e]}(e);if(!o)throw Error("Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.");o.appendChild(t)}},540(e){e.exports=function(e){var r=document.createElement("style");return e.setAttributes(r,e.attributes),e.insert(r,e.options),r}},5056(e,r,t){e.exports=function(e){var r=t.nc;r&&e.setAttribute("nonce",r)}},7825(e){e.exports=function(e){if("u"<typeof document)return{update:function(){},remove:function(){}};var r=e.insertStyleElement(e);return{update:function(t){var o,n,a;o="",t.supports&&(o+="@supports (".concat(t.supports,") {")),t.media&&(o+="@media ".concat(t.media," {")),(n=void 0!==t.layer)&&(o+="@layer".concat(t.layer.length>0?" ".concat(t.layer):""," {")),o+=t.css,n&&(o+="}"),t.media&&(o+="}"),t.supports&&(o+="}"),(a=t.sourceMap)&&"u">typeof btoa&&(o+="\n/*# sourceMappingURL=data:application/json;base64,".concat(btoa(unescape(encodeURIComponent(JSON.stringify(a))))," */")),e.styleTagTransform(o,r,e.options)},remove:function(){var e;null===(e=r).parentNode||e.parentNode.removeChild(e)}}}},1113(e){e.exports=function(e,r){if(r.styleSheet)r.styleSheet.cssText=e;else{for(;r.firstChild;)r.removeChild(r.firstChild);r.appendChild(document.createTextNode(e))}}}}]);