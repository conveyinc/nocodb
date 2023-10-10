"use strict";(self.webpackChunknoco_docs=self.webpackChunknoco_docs||[]).push([[1245],{3905:(e,t,i)=>{i.d(t,{Zo:()=>p,kt:()=>u});var r=i(67294);function a(e,t,i){return t in e?Object.defineProperty(e,t,{value:i,enumerable:!0,configurable:!0,writable:!0}):e[t]=i,e}function l(e,t){var i=Object.keys(e);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);t&&(r=r.filter((function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable}))),i.push.apply(i,r)}return i}function n(e){for(var t=1;t<arguments.length;t++){var i=null!=arguments[t]?arguments[t]:{};t%2?l(Object(i),!0).forEach((function(t){a(e,t,i[t])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(i)):l(Object(i)).forEach((function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(i,t))}))}return e}function o(e,t){if(null==e)return{};var i,r,a=function(e,t){if(null==e)return{};var i,r,a={},l=Object.keys(e);for(r=0;r<l.length;r++)i=l[r],t.indexOf(i)>=0||(a[i]=e[i]);return a}(e,t);if(Object.getOwnPropertySymbols){var l=Object.getOwnPropertySymbols(e);for(r=0;r<l.length;r++)i=l[r],t.indexOf(i)>=0||Object.prototype.propertyIsEnumerable.call(e,i)&&(a[i]=e[i])}return a}var d=r.createContext({}),s=function(e){var t=r.useContext(d),i=t;return e&&(i="function"==typeof e?e(t):n(n({},t),e)),i},p=function(e){var t=s(e.components);return r.createElement(d.Provider,{value:t},e.children)},m="mdxType",f={inlineCode:"code",wrapper:function(e){var t=e.children;return r.createElement(r.Fragment,{},t)}},c=r.forwardRef((function(e,t){var i=e.components,a=e.mdxType,l=e.originalType,d=e.parentName,p=o(e,["components","mdxType","originalType","parentName"]),m=s(i),c=a,u=m["".concat(d,".").concat(c)]||m[c]||f[c]||l;return i?r.createElement(u,n(n({ref:t},p),{},{components:i})):r.createElement(u,n({ref:t},p))}));function u(e,t){var i=arguments,a=t&&t.mdxType;if("string"==typeof e||a){var l=i.length,n=new Array(l);n[0]=c;var o={};for(var d in t)hasOwnProperty.call(t,d)&&(o[d]=t[d]);o.originalType=e,o[m]="string"==typeof e?e:a,n[1]=o;for(var s=2;s<l;s++)n[s]=i[s];return r.createElement.apply(null,n)}return r.createElement.apply(null,i)}c.displayName="MDXCreateElement"},53499:(e,t,i)=>{i.r(t),i.d(t,{assets:()=>d,contentTitle:()=>n,default:()=>f,frontMatter:()=>l,metadata:()=>o,toc:()=>s});var r=i(87462),a=(i(67294),i(3905));const l={title:"Time",description:"This article explains how to create & work with a Time field.",tags:["Fields","Field types","Date & Time"],keywords:["Fields","Field types","Date & Time","Create time field"]},n=void 0,o={unversionedId:"fields/field-types/date-time-based/time",id:"fields/field-types/date-time-based/time",title:"Time",description:"This article explains how to create & work with a Time field.",source:"@site/docs/070.fields/040.field-types/070.date-time-based/030.time.md",sourceDirName:"070.fields/040.field-types/070.date-time-based",slug:"/fields/field-types/date-time-based/time",permalink:"/fields/field-types/date-time-based/time",draft:!1,editUrl:"https://github.com/nocodb/nocodb/tree/develop/packages/noco-docs/docs/docs/070.fields/040.field-types/070.date-time-based/030.time.md",tags:[{label:"Fields",permalink:"/tags/fields"},{label:"Field types",permalink:"/tags/field-types"},{label:"Date & Time",permalink:"/tags/date-time"}],version:"current",sidebarPosition:30,frontMatter:{title:"Time",description:"This article explains how to create & work with a Time field.",tags:["Fields","Field types","Date & Time"],keywords:["Fields","Field types","Date & Time","Create time field"]},sidebar:"tutorialSidebar",previous:{title:"Date",permalink:"/fields/field-types/date-time-based/date"},next:{title:"Duration",permalink:"/fields/field-types/date-time-based/duration"}},d={},s=[{value:"Create a time field",id:"create-a-time-field",level:2},{value:"Supported time formats",id:"supported-time-formats",level:3},{value:"Related fields",id:"related-fields",level:2}],p={toc:s},m="wrapper";function f(e){let{components:t,...l}=e;return(0,a.kt)(m,(0,r.Z)({},p,l,{components:t,mdxType:"MDXLayout"}),(0,a.kt)("p",null,(0,a.kt)("inlineCode",{parentName:"p"},"Time")," field type is used to store time values in a single field. Time formats supported by NocoDB are listed in the table below."),(0,a.kt)("h2",{id:"create-a-time-field"},"Create a time field"),(0,a.kt)("ol",null,(0,a.kt)("li",{parentName:"ol"},"Click on ",(0,a.kt)("inlineCode",{parentName:"li"},"+")," icon to the right of ",(0,a.kt)("inlineCode",{parentName:"li"},"Fields header")),(0,a.kt)("li",{parentName:"ol"},"On the dropdown modal, enter the field name (Optional)"),(0,a.kt)("li",{parentName:"ol"},"Select the field type as ",(0,a.kt)("inlineCode",{parentName:"li"},"Time")," from the dropdown."),(0,a.kt)("li",{parentName:"ol"},"Configure default value (Optional)"),(0,a.kt)("li",{parentName:"ol"},"Click on ",(0,a.kt)("inlineCode",{parentName:"li"},"Save Field")," button.")),(0,a.kt)("p",null,(0,a.kt)("img",{alt:"image",src:i(36161).Z,width:"2876",height:"1192"})),(0,a.kt)("h3",{id:"supported-time-formats"},"Supported time formats"),(0,a.kt)("p",null,"Time format: HH:mm AM/PM (12-hour format)"),(0,a.kt)("h2",{id:"related-fields"},"Related fields"),(0,a.kt)("ul",null,(0,a.kt)("li",{parentName:"ul"},(0,a.kt)("a",{parentName:"li",href:"/fields/field-types/date-time-based/date-time"},"DateTime")),(0,a.kt)("li",{parentName:"ul"},(0,a.kt)("a",{parentName:"li",href:"/fields/field-types/date-time-based/date"},"Date")),(0,a.kt)("li",{parentName:"ul"},(0,a.kt)("a",{parentName:"li",href:"/fields/field-types/date-time-based/duration"},"Duration"))))}f.isMDXComponent=!0},36161:(e,t,i)=>{i.d(t,{Z:()=>r});const r=i.p+"assets/images/time-e7719917464163b50837ace0db5619c0.png"}}]);