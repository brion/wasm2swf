#!/usr/bin/env node

const fs = require('fs');
const binaryen = require('../lib/binaryen-patched');
const {
    ABCFileBuilder,
    Label,
    Namespace,
    Instance,
    Class,
    Trait,
    Script,
} = require('./abc');
const {SWFFileBuilder} = require('./swf');

function help() {
    console.error(`wasm2swf --sprite -o outfile.swf infile.wasm\n`);
    console.error(`  -o outfile.swf           save output as a loadable .swf movie`);
    console.error(`  -o outfile.abc           save output as raw .abc bytecode`);
    console.error(`  --sprite                 includes a stub Sprite class for Flash timeline`);
    console.error(`  --debug                  embed "line numbers" for debugging`);
    console.error(`  --trace                  emit trace() calls on every expression`);
    console.error(`  --trace-funcs            emit trace() calls on every function entry`);
    console.error(`  --trace-only=f1,f2       only trace in the given functions`);
    console.error(`  --trace-exclude=f1,f2    don't trace in the given functions`);
    console.error(`  --save-wat=outfile.wat   save the transformed Wasm source`);
    console.error(`\n`);
}

let infile, outfile;
let sprite = false;
let debug = false;
let trace = false;
let traceFuncs = false;
let traceOnly = [];
let traceExclude = [];
let saveWat;

function shouldTrace(funcName) {
    if (traceExclude.indexOf(funcName) !== -1) {
        return false;
    }
    if (traceOnly.length > 0) {
        return traceOnly.indexOf(funcName) !== -1;
    }
    return true;
}

let args = process.argv.slice(2);
while (args.length > 0) {
    let arg = args.shift();
    let val;
    function prefixed(prefix) {
        if (arg.startsWith(prefix)) {
            val = arg.substr(prefix.length);;
            return true;
        }
        return false;
    }
    switch (arg) {
        case '-o':
        case '--output':
            outfile = args.shift();
            break;
        case '--sprite':
            sprite = true;
            break;
        case '--debug':
            debug = true;
            break;
        case '--trace':
            trace = true;
            break;
        case '--trace-funcs':
            traceFuncs = true;
            break;
        case '--help':
            help();
            process.exit(0);
            break;
        default:
            if (prefixed('--trace-only=')) {
                traceOnly = val.split(',');
                continue;
            }
            if (prefixed('--trace-exclude=')) {
                traceExclude = val.split(',');
                continue;
            }
            if (prefixed('--save-wat=')) {
                saveWat = val;
                continue;
            }

            if (infile) {
                console.error(`Too many input files, can take only one!\n`);
                help();
                process.exit(1);
            }

            infile = arg;
    }
}

if (!infile) {
    console.error(`Must provide an input .wasm file!\n`);
    help();
    process.exit(1);
}
if (!outfile) {
    console.error(`Must provide an output .swf or .abc file!\n`);
    help();
    process.exit(1);
}
if (!(outfile.endsWith('.swf') || outfile.endsWith('.abc'))) {
    console.error(`Output file must have .abc or .swf extension.\n`);
    help();
    process.exit(1);
}

function convertModule(mod) {
    const abc = new ABCFileBuilder();

    function ns(kind, str) {
        return abc.namespace(kind, abc.string(str));
    }

    function qname(ns, str) {
        return abc.qname(ns, abc.string(str));
    }

    let pubns = ns(Namespace.PackageNamespace, '');
    let voidName = qname(pubns, 'void');
    let intName = qname(pubns, 'int');
    let uintName = qname(pubns, 'uint');
    let numberName = qname(pubns, 'Number');
    let stringName = qname(pubns, 'String');
    let objectName = qname(pubns,'Object');
    let arrayName = qname(pubns, 'Array');
    let mathName = qname(pubns, 'Math');
    let traceName = qname(pubns, 'trace');
    let exportsName = qname(pubns, 'exports');
    let lengthName = qname(pubns, 'length');
    let charCodeAtName = qname(pubns, 'charCodeAt');

    let instanceName = qname(pubns, 'Instance'); // @fixme make this proper

    let privatens = ns(Namespace.PrivateNs, '');
    let memoryName = qname(privatens, 'wasm$memory');
    let tableName = qname(privatens, 'wasm$table');
    let memoryGrowName = qname(privatens, 'wasm$memory_grow');
    let memorySizeName = qname(privatens, 'wasm$memory_size');
    let memoryInitName = qname(privatens, 'wasm$memory_init');
    let clz32Name = qname(privatens, 'wasm$clz32');

    let scratch_load_i32 = qname(privatens, 'func$wasm2js_scratch_load_i32');
    let scratch_load_i64 = qname(privatens, 'func$wasm2js_scratch_load_i64');
    let scratch_load_f32 = qname(privatens, 'func$wasm2js_scratch_load_f32');
    let scratch_load_f64 = qname(privatens, 'func$wasm2js_scratch_load_f32');

    let scratch_store_i32 = qname(privatens, 'func$wasm2js_scratch_store_i32');
    let scratch_store_i64 = qname(privatens, 'func$wasm2js_scratch_store_i64');
    let scratch_store_f32 = qname(privatens, 'func$wasm2js_scratch_store_f32');
    let scratch_store_f64 = qname(privatens, 'func$wasm2js_scratch_store_f32');

    let builtinns = ns(Namespace.PackageNamespace, 'http://adobe.com/AS3/2006/builtin');
    let joinName = qname(builtinns, 'join');

    let flashutilsns = ns(Namespace.Namespace, 'flash.utils');
    let byteArrayName = qname(flashutilsns, 'ByteArray');

    let type_v = binaryen.createType([]);
    let type_j = binaryen.createType([binaryen.i64]);
    let type_i = binaryen.createType([binaryen.i32]);
    let type_ii = binaryen.createType([binaryen.i32, binaryen.i32]);
    let type_f = binaryen.createType([binaryen.f32]);
    let type_d = binaryen.createType([binaryen.f64]);

    let classTraits = [];
    let instanceTraits = [];

    let knownGlobals = {};
    function addGlobal(name, type, info) {
        if (!knownGlobals[name]) {
            instanceTraits.push(abc.trait({
                name: name,
                kind: Trait.Slot,
                type_name: type,
            }));
            knownGlobals[name] = {
                info
            };
        }
    }
    addGlobal(exportsName, objectName);
    addGlobal(memoryName, byteArrayName);
    addGlobal(tableName, arrayName);

    function addImport(name, params, ret) {
        mod.addFunctionImport(
            name,
            'env',
            name,
            params,
            ret
        );
        // hack to keep them alive
        // may be better to do differently?
        mod.addFunctionExport(name, name);
    }

    addImport('wasm2js_scratch_store_i32', type_ii, binaryen.void);
    addImport('wasm2js_scratch_load_i32', type_i, binaryen.i32);
    addImport('wasm2js_scratch_store_i64', type_j, binaryen.void);
    addImport('wasm2js_scratch_load_i64', type_v, binaryen.i64);
    addImport('wasm2js_scratch_store_f32', type_f, binaryen.void);
    addImport('wasm2js_scratch_load_f32', type_v, binaryen.f32);
    addImport('wasm2js_scratch_store_f64', type_d, binaryen.void);
    addImport('wasm2js_scratch_load_f64', type_v, binaryen.f64);

    // Can we get this list from binaryen?
    let ids = [
        'Invalid',
        'Block',
        'If',
        'Loop',
        'Break',
        'Switch',
        'Call',
        'CallIndirect',
        'LocalGet',
        'LocalSet',
        'GlobalGet',
        'GlobalSet',
        'Load',
        'Store',
        'Const',
        'Unary',
        'Binary',
        'Select',
        'Drop',
        'Return',
        'Host',
        'Nop',
        'Unreachable',
        'AtomicCmpxchg',
        'AtomicRMW',
        'AtomicWait',
        'AtomicNotify',
        'AtomicFence',
        'SIMDExtract',
        'SIMDReplace',
        'SIMDShuffle',
        'SIMDTernary',
        'SIMDShift',
        'SIMDLoad',
        'MemoryInit',
        'DataDrop',
        'MemoryCopy',
        'MemoryFill',
        'Try',
        'Throw',
        'Rethrow',
        'BrOnExn',
        'Push',
        'Pop',
    ];
    let expressionTypes = [];
    for (let name of ids) {
        expressionTypes[binaryen[name + 'Id']] = name;
    }

    const U30_MAX = 2 ** 30 - 1;

    function avmType(t) {
        switch (t) {
            case binaryen.none: return 'void';
            case binaryen.i32: return 'int';
            case binaryen.f32: return 'Number';
            case binaryen.f64: return 'Number';
            default: throw new Error('unexpected type ' + t);
        }
    }

    const imports = [];

    function walkExpression(expr, callbacks) {
        let info = binaryen.getExpressionInfo(expr);
        let cb = 'visit' + expressionTypes[info.id];
        if (callbacks[cb]) {
            callbacks[cb](info, expr);
        } else {
            throw new Error(`Unhandled node of type ${info.id}`);
        }
    }

    function hasSideEffects(expr) {
        let info = binaryen.getExpressionInfo(expr);
        switch (info.id) {
            case binaryen.ConstId:
            case binaryen.LocalGetId:
            case binaryen.GlobalGetId:
            case binaryen.LoadId:
            case binaryen.NopId:
                return false;
            case binaryen.BinaryId:
                return hasSideEffects(info.left) ||
                    hasSideEffects(info.right);
            case binaryen.UnaryId:
                // technically, some unary ops overwrite scratch space
                // this should not be an issue though.
                return hasSideEffects(info.value);
            case binaryen.SelectId:
                return hasSideEffects(info.ifTrue) ||
                    hasSideEffects(info.ifFalse) ||
                    hasSideEffects(info.condition);
            default:
                return true;
        }
    }

    function convertFunction(func) {
        const builder = abc.methodBuilder();
        let labelStack = [];

        function labelByName(name) {
            let label = labelStack.find((label) => label.name == name);
            if (!label) {
                throw new Error('cannot find label ' + name);
            }
            return label;
        }

        function pushOffset(offset) {
            if (offset > 1) {
                builder.pushint_value(offset);
                builder.add_i();
            } else if (offset === 1) {
                builder.increment_i();
            } else if (offset < 0) {
                throw new Error('invalid negative offset');
            }
        }

        function foldConditional(condition, label) {
            let cond = binaryen.getExpressionInfo(condition);
            if (cond.id === binaryen.BinaryId) {
                // Note these are backwards from 'if' which branches
                // when the condition is false. :)
                switch (cond.op) {
                    case binaryen.EqInt32:
                    case binaryen.EqFloat32:
                    case binaryen.EqFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.ifstricteq(label);
                        return;
                    case binaryen.NeInt32:
                    case binaryen.NeFloat32:
                    case binaryen.NeFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.ifstrictne(label);
                        return;
                    case binaryen.LtSInt32:
                    case binaryen.LtFloat32:
                    case binaryen.LtFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.iflt(label);
                        return;
                    case binaryen.LtUInt32:
                        traverse(cond.left);
                        builder.convert_u();
                        traverse(cond.right);
                        builder.convert_u();
                        builder.iflt(label);
                        return;
                    case binaryen.LeSInt32:
                    case binaryen.LeFloat32:
                    case binaryen.LeFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.ifle(label);
                        return;
                    case binaryen.LeUInt32:
                        traverse(cond.left);
                        builder.convert_u();
                        traverse(cond.right);
                        builder.convert_u();
                        builder.ifle(label);
                        return;
                    case binaryen.GtSInt32:
                    case binaryen.GtFloat32:
                    case binaryen.GtFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.ifgt(label);
                        return;
                    case binaryen.GtUInt32:
                        traverse(cond.left);
                        builder.convert_u();
                        traverse(cond.right);
                        builder.convert_u();
                        builder.ifgt(label);
                        return;
                    case binaryen.GeSInt32:
                    case binaryen.GeFloat32:
                    case binaryen.GeFloat64:
                        traverse(cond.left);
                        traverse(cond.right);
                        builder.ifge(label);
                        return;
                    case binaryen.GeUInt32:
                        traverse(cond.left);
                        builder.convert_u();
                        traverse(cond.right);
                        builder.convert_u();
                        builder.ifge(label);
                        return;

                    default:
                        // fall through
                }
            } else if (cond.id === binaryen.UnaryId) {
                if (cond.op === binaryen.EqZInt32) {
                    traverse(cond.value);
                    builder.iffalse(label);
                    return;
                }
                // fall through
            }

            traverse(condition);
            builder.iftrue(label);
        }

        const callbacks = {
            visitBlock: (info) => {
                let name = info.name;
                let label = new Label(name);
                labelStack.push(label);
                info.children.forEach(traverse);
                if (label.used) {
                    builder.label(label);
                }
                labelStack.pop();
            },

            visitIf: (info) => {
                let cond = binaryen.getExpressionInfo(info.condition);
                let ifend = new Label();
                if (cond.id == binaryen.BinaryId) {
                    switch(cond.op) {
                        case binaryen.EqInt32:
                        case binaryen.EqFloat32:
                        case binaryen.EqFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifstrictne(ifend);
                            break;
                        case binaryen.NeInt32:
                        case binaryen.NeFloat32:
                        case binaryen.NeFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifstricteq(ifend);
                            break;
                        case binaryen.LtSInt32:
                        case binaryen.LtFloat32:
                        case binaryen.LtFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifnlt(ifend);
                            break;
                        case binaryen.LtUInt32:
                            traverse(cond.left);
                            builder.convert_u();
                            traverse(cond.right);
                            builder.convert_u();
                            builder.ifnlt(ifend);
                            break;
                        case binaryen.LeSInt32:
                        case binaryen.LeFloat32:
                        case binaryen.LeFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifnle(ifend);
                            break;
                        case binaryen.LeUInt32:
                            traverse(cond.left);
                            builder.convert_u();
                            traverse(cond.right);
                            builder.convert_u();
                            builder.ifnle(ifend);
                            break;
                        case binaryen.GtSInt32:
                        case binaryen.GtFloat32:
                        case binaryen.GtFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifngt(ifend);
                            break;
                        case binaryen.GtUInt32:
                            traverse(cond.left);
                            builder.convert_u();
                            traverse(cond.right);
                            builder.convert_u();
                            builder.ifngt(ifend);
                            break;
                        case binaryen.GeSInt32:
                        case binaryen.GeFloat32:
                        case binaryen.GeFloat64:
                            traverse(cond.left);
                            traverse(cond.right);
                            builder.ifnge(ifend);
                            break;
                        case binaryen.GeUInt32:
                            traverse(cond.left);
                            builder.convert_u();
                            traverse(cond.right);
                            builder.convert_u();
                            builder.ifnge(ifend);
                            break;
                        default:
                            traverse(info.condition);
                            builder.iffalse(ifend);
                    }
                } else if (cond.id == binaryen.UnaryId) {
                    switch(cond.op) {
                        case binaryen.EqZInt32:
                            traverse(cond.value);
                            builder.iftrue(ifend);
                            break;
                        default:
                            traverse(info.condition);
                            builder.iffalse(ifend);
                    }
                } else {
                    traverse(info.condition);
                    builder.iffalse(ifend);
                }

                traverse(info.ifTrue);

                if (info.ifFalse) {
                    let elseend = new Label();
                    builder.jump(elseend);
                    builder.label(ifend);

                    traverse(info.ifFalse);

                    builder.label(elseend);
                } else {
                    builder.label(ifend);
                }
            },
        
            visitLoop: (info) => {
                let start = new Label(info.name);
                labelStack.push(start);
                builder.label(start);
                traverse(info.body);
                labelStack.pop();
            },
        
            visitBreak: (info) => {
                let label = labelByName(info.name);
                if (info.value) {
                    throw new Error('not sure what to do with info.value?')
                    traverse(info.value);
                }
                if (info.condition) {
                    foldConditional(info.condition, label);
                } else {
                    builder.jump(label);
                }
            },

            visitSwitch: (info, expr) => {
                if (info.value) {
                    throw new Error('not sure what to do with info.value?')
                    traverse(info.value);
                }
                traverse(info.condition);
                let default_label = labelByName(info.defaultName);
                let case_labels = info.names.map(labelByName);
                builder.lookupswitch(default_label, case_labels);
            },

            visitCall: (info) => {
                builder.getlocal_0(); // this argument
                info.operands.forEach(traverse);
                let method = qname(privatens, 'func$' + info.target);
                switch (info.type) {
                    case binaryen.none:
                        builder.callpropvoid(method, info.operands.length);
                        break;
                    case binaryen.i32:
                        builder.callproperty(method, info.operands.length);
                        builder.convert_i();
                        break;
                    case binaryen.f32:
                    case binaryen.f64:
                        builder.callproperty(method, info.operands.length);
                        builder.convert_d();
                        break;
                    default:
                        throw new Error('unexpected type in call ' + info.type);
                }
            },

            visitCallIndirect: (info) => {
                // The target for callproperty comes after parameters in Wasm,
                // but before in AVM2.
                //
                // We check for possible side effects and use temporaries to evaluate
                // in order if so; if there are no side effects then they are reordered
                // for efficiency.
                //
                // This check is fairly conservative for now.

                let args = info.operands.length;
                let reorder = hasSideEffects(info.target);
                let paramLocals = [];
                for (let operand of info.operands) {
                    reorder = reorder || hasSideEffects(operand);
                }

                if (reorder) {
                    // WARNING: THIS WILL BREAK WITH --trace for now
                    if (trace) {
                        throw new Error('temp incompatibility with --trace for callIndirect');
                    }

                    // Store in temporary locals
                    for (let i = 0; i < args; i++) {
                        let index = freeLocal++;
                        paramLocals[i] = index;
                        traverse(info.operands[i]);
                        builder.setlocal(index);
                    }
                }

                // Grab the table and the target
                builder.getlocal_0(); // this argument
                builder.getproperty(tableName);
                builder.coerce(arrayName);
                traverse(info.target);

                if (reorder) {
                    // Now get those args back
                    for (let i = 0; i < args; i++) {
                        builder.getlocal(paramLocals[i]);
                        builder.kill(paramLocals[i]);
                    }

                    // And release them for later reuse.
                    freeLocal -= args;
                } else {
                    // No side effects, so just pull everything in.
                    for (let operand of info.operands) {
                        traverse(operand);
                    }
                }

                let pubset = abc.namespaceSet([pubns]);
                let runtime = abc.multinameL(pubset);
                switch (info.type) {
                    case binaryen.none:
                        builder.callpropvoid(runtime, args);
                        break;
                    case binaryen.i32:
                        builder.callproperty(runtime, args);
                        builder.convert_i();
                        break;
                    case binaryen.f32:
                    case binaryen.f64:
                        builder.callproperty(runtime, args);
                        builder.convert_d();
                        break;
                    default:
                        throw new Error('unexpected type in indirect call ' + info.type);
                }
            },

            visitLocalGet: (info) => {
                // AVM locals are shifted over by one versus WebAssembly,
                // because the 0 index is used for the 'this' parameter.
                let i = info.index + 1;
                builder.getlocal(i);
            },

            visitLocalSet: (info) => {
                // AVM locals are shifted over by one versus WebAssembly,
                // because the 0 index is used for the 'this' parameter.
                let i = info.index + 1;

                let value = binaryen.getExpressionInfo(info.value);
                if (value.id == binaryen.BinaryId && value.op == binaryen.AddInt32) {
                    let left = binaryen.getExpressionInfo(value.left);
                    let right = binaryen.getExpressionInfo(value.right);
                    if (left.id == binaryen.LocalGetId &&
                        left.index == info.index &&
                        right.id == binaryen.ConstId
                    ) {
                        if (right.value === 1) {
                            builder.inclocal_i(i);
                            if (info.isTee) {
                                builder.getlocal(i);
                            }
                            return;
                        } else if (right.value === -1) {
                            builder.declocal_i(i);
                            if (info.isTee) {
                                builder.getlocal(i);
                            }
                            return;
                        }
                    }
                }

                traverse(info.value);
                if (info.isTee) {
                    builder.dup();
                }
                builder.setlocal(i);
            },

            visitGlobalGet: (info) => {
                let globalId = mod.getGlobal(info.name);
                let globalInfo = binaryen.getGlobalInfo(globalId);

                let name = qname(privatens, 'global$' + globalInfo.name);
                let type = qname(pubns, avmType(globalInfo.type));
                addGlobal(name, type, globalInfo);
        
                builder.getlocal_0(); // 'this' param
                builder.getproperty(name);
                switch (info.type) {
                    case binaryen.i32:
                        builder.convert_i();
                        break;
                    case binaryen.f32:
                    case binaryen.f64:
                        builder.convert_d();
                        break;
                    default:
                        throw new Error('unexpected global type ' + info.type);
                }
            },

            visitGlobalSet: (info) => {
                let globalId = mod.getGlobal(info.name);
                let globalInfo = binaryen.getGlobalInfo(globalId);

                let name = qname(privatens, 'global$' + globalInfo.name);
                let type = qname(pubns, avmType(globalInfo.type));
                addGlobal(name, type, globalInfo);

                builder.getlocal_0();
                traverse(info.value);
                builder.setproperty(name);
            },

            visitLoad: (info) => {
                // todo: can be isAtomic

                traverse(info.ptr);
                pushOffset(info.offset);

                switch (info.type) {
                    case binaryen.i32:
                        switch (info.bytes) {
                            case 1:
                                builder.li8();
                                if (info.isSigned) {
                                    builder.sxi8();
                                }
                                break;
                            case 2:
                                builder.li16();
                                if (info.isSigned) {
                                    builder.sxi16();
                                }
                                break;
                            case 4:
                                builder.li32();
                                break;
                        }
                        break;
                    case binaryen.f32:
                        builder.lf32();
                        break;
                    case binaryen.f64:
                        builder.lf64();
                        break;
                    default:
                        throw new Error('unexpected load type ' + info.type);
                }
            },

            visitStore: (info) => {
                // todo: can be isAtomic

                // Flash's si32/si16/si8/sf32/sf64 instructions take
                // value then pointer, but Wasm stores take pointer
                // then value.
                let reorder = hasSideEffects(info.ptr) || hasSideEffects(info.value);
                if (reorder) {
                    traverse(info.ptr);
                    pushOffset(info.offset);
                    traverse(info.value);
                    builder.swap();
                } else {
                    traverse(info.value);
                    traverse(info.ptr);
                    pushOffset(info.offset);
                }

                let value = binaryen.getExpressionInfo(info.value);
                switch (value.type) {
                    case binaryen.i32:
                        switch (info.bytes) {
                            case 1:
                                builder.si8();
                                break;
                            case 2:
                                builder.si16();
                                break;
                            case 4:
                                builder.si32();
                                break;
                            default:
                                throw new Error('unexpected store size ' + info.bytes);
                        }
                        break;
                    case binaryen.f32:
                        builder.sf32();
                        break;
                    case binaryen.f64:
                        builder.sf64();
                        break;
                    default:
                        throw new Error('unexpected store type ' + value.type);
                }
            },

            visitConst: (info) => {
                switch (info.type) {
                    case binaryen.i32:
                        builder.pushint_value(info.value);
                        break;
                    case binaryen.f32:
                    case binaryen.f64:
                        if (isNaN(info.value)) {
                            builder.pushnan();
                        } else {
                            let index = abc.double(info.value);
                            builder.pushdouble(index);
                        }
                        break;
                    default:
                        throw new Error('unexpected const type ' + info.type);
                }
            },

            visitUnary: (info) => {
                switch (info.op) {
                    // int
                    case binaryen.ClzInt32:
                        builder.getlocal_0(); // 'this'
                        traverse(info.value);
                        builder.callproperty(clz32Name, 1);
                        builder.convert_i();
                        break;
                    case binaryen.CtzInt32:
                    case binaryen.PopcntInt32:
                        throw new Error('i32 unary should be removed');
                        break;

                    // float
                    case binaryen.NegFloat32:
                    case binaryen.NegFloat64:
                        traverse(info.value);
                        builder.negate();
                        break;
                    case binaryen.AbsFloat32:
                    case binaryen.AbsFloat64:
                        builder.getlex(mathName);
                        traverse(info.value);
                        builder.callproperty(qname(pubns, 'abs'), 1);
                        builder.convert_d();
                        break;
                    case binaryen.CeilFloat32:
                    case binaryen.CeilFloat64:
                        builder.getlex(mathName);
                        traverse(info.value);
                        builder.callproperty(qname(pubns, 'ceil'), 1);
                        builder.convert_d();
                        break;
                    case binaryen.FloorFloat32:
                    case binaryen.FloorFloat64:
                        builder.getlex(mathName);
                        traverse(info.value);
                        builder.callproperty(qname(pubns, 'floor'), 1);
                        builder.convert_d();
                        break;
                    case binaryen.TruncFloat32:
                    case binaryen.TruncFloat64:
                        throw new Error('trunc should be removed');
                        break;
                    case binaryen.NearestFloat32:
                    case binaryen.NearestFloat64:
                        throw new Error('nearest should be removed');
                        break;
                    case binaryen.SqrtFloat32:
                    case binaryen.SqrtFloat64:
                        builder.getlex(mathName);
                        traverse(info.value);
                        builder.callproperty(qname(pubns, 'sqrt'), 1);
                        builder.convert_d();
                        break;


                    // relational
                    case binaryen.EqZInt32:
                        traverse(info.value);
                        builder.not();
                        builder.convert_i();
                        break;

                    // float to int
                    case binaryen.TruncSFloat32ToInt32:
                    case binaryen.TruncSFloat64ToInt32:
                        traverse(info.value);
                        builder.convert_i(); // ??? check rounding
                        break;
                    case binaryen.TruncUFloat32ToInt32:
                    case binaryen.TruncUFloat64ToInt32:
                        traverse(info.value);
                        builder.convert_u(); // ??? check rounding
                        builder.convert_i();
                        break;
                    case binaryen.ReinterpretFloat32:
                        builder.getlocal_0();
                        traverse(info.value);
                        builder.callpropvoid(scratch_store_f32, 1);

                        builder.getlocal_0();
                        builder.pushbyte(0);
                        builder.callproperty(scratch_load_i32, 1);
                        builder.convert_i();

                        break;
                    case binaryen.ReinterpretFloat64:
                        throw new Error('reinterpret f64 should be removed already');
                        break;
                    case binaryen.ConvertSInt32ToFloat32:
                    case binaryen.ConvertSInt32ToFloat64:
                        traverse(info.value);
                        builder.convert_d();
                        break;
                    case binaryen.ConvertUInt32ToFloat32:
                    case binaryen.ConvertUInt32ToFloat64:
                        traverse(info.value);
                        builder.convert_u();
                        builder.convert_d();
                        break;
                    case binaryen.PromoteFloat32:
                        // nop
                        traverse(info.value);
                        break;
                    case binaryen.DemoteFloat64:
                        builder.getlocal_0();
                        traverse(info.value);
                        builder.callpropvoid(scratch_store_f64, 1);

                        builder.getlocal_0();
                        builder.callproperty(scratch_load_f32, 0);
                        builder.convert_d();
                        break;
                    case binaryen.ReinterpretInt32:
                        builder.getlocal_0();
                        builder.pushbyte(0);
                        traverse(info.value);
                        builder.callpropvoid(scratch_store_i32, 2);

                        builder.getlocal_0();
                        builder.callproperty(scratch_load_f32, 0);
                        builder.convert_d();

                        break;
                    case binaryen.ReinterpretInt64:
                        throw new Error('reinterpret int should be removed already');
                        break;
                    
                    default:
                        throw new Error('unhandled unary op ' + info.op);
                }
            },

            visitBinary: (info) => {
                let right;
                switch (info.op) {
                    // int or float
                    case binaryen.AddInt32:
                        traverse(info.left);
                        right = binaryen.getExpressionInfo(info.right);
                        if (right.id == binaryen.ConstId && right.value == 1) {
                            builder.increment_i();
                        } else if (right.id == binaryen.ConstId && right.value == -1) {
                            builder.decrement_i();
                        } else {
                            traverse(info.right);
                            builder.add_i();
                        }
                        break;
                    case binaryen.SubInt32:
                        traverse(info.left);
                        right = binaryen.getExpressionInfo(info.right);
                        if (right.id == binaryen.ConstId && right.value == 1) {
                            builder.decrement_i();
                        } else if (right.id == binaryen.ConstId && right.value == -1) {
                            builder.increment_i();
                        } else {
                            traverse(info.right);
                            builder.subtract_i();
                        }
                        break;
                    case binaryen.MulInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.multiply_i();
                        break;

                    // int
                    case binaryen.DivSInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.divide();
                        builder.convert_i();
                        break;
                    case binaryen.DivUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.divide();
                        builder.convert_u();
                        builder.convert_i();
                        break;
                    case binaryen.RemSInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.modulo();
                        builder.convert_i();
                        break;
                    case binaryen.RemUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.modulo();
                        builder.convert_u();
                        builder.convert_i();
                        break;

                    case binaryen.AndInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.bitand();
                        break;
                    case binaryen.OrInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.bitor();
                        break;
                    case binaryen.XorInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.bitxor();
                        break;
                    case binaryen.ShlInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.lshift();
                        break;
                    case binaryen.ShrUInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.urshift();
                        builder.convert_i();
                        break;
                    case binaryen.ShrSInt32:
                        traverse(info.left);
                        traverse(info.right);
                        builder.rshift();
                        break;
                    case binaryen.RotLInt32:
                        throw new Error('rotate should be removed already');
                        break;
                    case binaryen.RotRInt32:
                        throw new Error('rotate should be removed already');
                        break;

                    // relational ops
                    // int or float
                    case binaryen.EqInt32:
                    case binaryen.EqFloat32:
                    case binaryen.EqFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.strictequals();
                        builder.convert_i();
                        break;
                    case binaryen.NeInt32:
                    case binaryen.NeFloat32:
                    case binaryen.NeFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.strictequals();
                        builder.not();
                        builder.convert_i();
                        break;
                    case binaryen.LtSInt32:
                    case binaryen.LtFloat32:
                    case binaryen.LtFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.lessthan();
                        builder.convert_i();
                        break;
                    case binaryen.LtUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.lessthan();
                        builder.convert_i();
                        break;
                    case binaryen.LeSInt32:
                    case binaryen.LeFloat32:
                    case binaryen.LeFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.lessequals();
                        builder.convert_i();
                        break;
                    case binaryen.LeUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.lessequals();
                        builder.convert_i();
                        break;
                    case binaryen.GtSInt32:
                    case binaryen.GtFloat32:
                    case binaryen.GtFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.greaterthan();
                        builder.convert_i();
                        break;
                    case binaryen.GtUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.greaterthan();
                        builder.convert_i();
                        break;
                    case binaryen.GeSInt32:
                    case binaryen.GeFloat32:
                    case binaryen.GeFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.greaterequals();
                        builder.convert_i();
                        break;
                    case binaryen.GeUInt32:
                        traverse(info.left);
                        builder.convert_u();
                        traverse(info.right);
                        builder.convert_u();
                        builder.greaterequals();
                        builder.convert_i();
                        break;

                    // int or float
                    case binaryen.AddFloat32:
                    case binaryen.AddFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.add();
                        break;
                    case binaryen.SubFloat32:
                    case binaryen.SubFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.subtract();
                        break;
                    case binaryen.MulFloat32:
                    case binaryen.MulFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.multiply();
                        break;

                    // float
                    case binaryen.DivFloat32:
                    case binaryen.DivFloat64:
                        traverse(info.left);
                        traverse(info.right);
                        builder.divide();
                        break;
                    case binaryen.CopySignFloat32:
                    case binaryen.CopySignFloat64:
                        throw new Error('copy sign should be removed already');
                        break;
                    case binaryen.MinFloat32:
                    case binaryen.MinFloat64:
                        builder.getlex(mathName);
                        traverse(info.left);
                        traverse(info.right);
                        builder.callproperty(qname(pubns, 'min'), 2);
                        builder.convert_d();
                        break;
                    case binaryen.MaxFloat32:
                    case binaryen.MaxFloat64:
                        builder.getlex(mathName);
                        traverse(info.left);
                        traverse(info.right);
                        builder.callproperty(qname(pubns, 'max'), 2);
                        builder.convert_d();
                        break;
                    
                    default:
                        throw new Error('unexpected binary op' + info);
                }
            },

            visitSelect: (info) => {
                traverse(info.ifTrue);
                traverse(info.ifFalse);

                let label = new Label();
                foldConditional(info.condition, label);

                builder.swap();
                builder.label(label);
                builder.pop();
            },

            visitDrop: (info) => {
                traverse(info.value);
                builder.pop();
            },

            visitReturn: (info) => {
                if (info.value) {
                    traverse(info.value);
                    builder.returnvalue();
                } else {
                    builder.returnvoid();
                }
            },

            visitHost: (info) => {
                switch (info.op) {
                    case binaryen.MemoryGrow:
                        builder.getlocal_0(); // 'this'
                        traverse(info.operands[0]);
                        builder.callproperty(memoryGrowName, 1);
                        builder.convert_i();
                        break;
                    case binaryen.MemorySize:
                        builder.getlocal_0(); // 'this'
                        builder.callproperty(memorySizeName, 0);
                        builder.convert_i();
                        break;
                    default:
                        throw new ('unknown host operation ' + info.op);
                }
            },

            visitNop: (info) => {
                builder.nop();
            },

            visitUnreachable: (info) => {
                builder.getlex(qname(pubns, 'Error'));
                builder.pushstring(abc.string('unreachable'));
                builder.construct(1);
                builder.throw();
            }
        };

        let info = binaryen.getFunctionInfo(func);
        var funcName = info.name; // var to use above. sigh
        let argTypes = binaryen.expandType(info.params).map(avmType);
        var resultType = avmType(info.results);
        let varTypes = info.vars.map(avmType);
        let localTypes = argTypes.concat(varTypes);
        var localCount = localTypes.length + 1;
        var freeLocal = localCount;

        let lineno = 1;
        if (debug && shouldTrace(funcName)) {
            builder.debugfile(abc.string('func$' + info.name));
        }
        function traverse(expr) {
            if (debug && shouldTrace(funcName)) {
                builder.debugline(lineno);
            }
            lineno++;
            walkExpression(expr, callbacks);
        }

        /*
        console.log('\n\nfunc ' + info.name);
        console.log('  (' + argTypes.join(', ') + ')');
        console.log('  -> ' + resultType);
        if (info.vars.length > 0) {
            console.log('  var ' + varTypes.join(', '));
        }
        console.log('{');
        */

        if (info.module === '') {
            // Regular function

            if (traceFuncs && shouldTrace(funcName)) {
                builder.getlex(traceName);
                builder.pushnull();
                builder.pushstring(abc.string(info.name + ': '));
                for (let n = 0; n < argTypes.length; n++) {
                    builder.getlocal(n + 1);
                }
                builder.newarray(argTypes.length);
                builder.pushstring(abc.string(', '));
                builder.callproperty(joinName, 1);
                builder.add();
                builder.call(1);
                builder.pop();
            }

            if (trace && shouldTrace(funcName)) {
                builder.tracing = true;
                builder.trace_locals = localCount;
            }

            // Just to be safe, ensure the args are of proper type
            builder.getlocal_0();
            builder.coerce(instanceName);
            builder.setlocal_0();
            let localBase = localTypes.length - varTypes.length;
            for (let i = 0; i < localBase; i++) {
                let type = localTypes[i];
                let index = i + 1;
                builder.getlocal(index);
                switch (type) {
                    case 'int':
                        builder.convert_i();
                        break;
                    case 'Number':
                        builder.convert_d();
                        break;
                    default:
                        throw new Error('unexpected local type ' + type);
                }
                builder.setlocal(index);
            }

            // Initialize local vars to their correct type
            for (let i = localBase; i < localTypes.length; i++) {
                let type = localTypes[i];
                let index = i + 1;
                switch (type) {
                    case 'int':
                        builder.pushbyte(0);
                        builder.setlocal(index);
                        break;
                    case 'Number':
                        builder.pushdouble(abc.double(0));
                        builder.setlocal(index);
                        break;
                    default:
                        throw new Error('unexpected local type ' + type);
                }
            }

            if (info.body) {
                traverse(info.body);
            }

            if (info.results == binaryen.none) {
                // why dont we have one?
                if (traceFuncs && shouldTrace(funcName)) {
                    builder.getlex(traceName);
                    builder.pushnull();
                    builder.pushstring(abc.string('void returned from ' + funcName));
                    builder.call(1);
                    builder.pop();
                }
                builder.returnvoid();
            } else {
                // we should already have one
                //builder.returnvalue();
            }
        } else {
            // Import function.
            //console.log('import from: ' + info.module + '.' + info.base);
            let name = qname(privatens, 'import$' + info.module + '$' + info.base);
            instanceTraits.push(abc.trait({
                name: name,
                kind: Trait.Slot,
                type_name: qname(pubns, 'Function')
            }));
            imports.push(info);
            builder.getlocal_0();
            for (let index = 0; index < argTypes.length; index++) {
                builder.getlocal(index + 1);
            }
            if (info.results == binaryen.none) {
                builder.callpropvoid(name, argTypes.length);
                attachDomainMemory(builder);
                builder.returnvoid();
            } else {
                builder.callproperty(name, argTypes.length);
                attachDomainMemory(builder);
                // return value will be coerced to the correct type if different
                builder.returnvalue();
            }
        }

        let method = abc.method({
            name: abc.string(info.name),
            return_type: qname(pubns, resultType),
            param_types: argTypes.map((type) => qname(pubns, type)),
        });

        abc.methodBody({
            method,
            local_count: builder.max_local + 1,
            init_scope_depth: 3,
            max_scope_depth: 3,
            max_stack: builder.max_stack,
            code: builder.toBytes()
        });

        instanceTraits.push(abc.trait({
            name: qname(privatens, 'func$' + info.name),
            kind: Trait.Method | Trait.Final,
            disp_id: method, // compiler-assigned, so use the same one
            method
        }));

        //console.log('}');

        // @fixme we must also add it to the class

    }

    function binaryString(data) {
        let bytes = new Uint8Array(data);
        let len = bytes.length;
        let arr = new Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = String.fromCharCode(bytes[i]);
        }
        return arr.join('');
    }

    binaryen.setOptimizeLevel(3); // yes, this is global.
    mod.runPasses([
        'legalize-js-interface', // done by wasm2js to change interface types
        'remove-non-js-ops', // done by wasm2js, will introduce intrinsics?
        'flatten', // needed by i64 lowering
        'i64-to-i32-lowering', // needed to grok i64s in i32-world
        //'alignment-lowering', // force aligned accesses
    ]);
    mod.optimize();
    mod.runPasses([
        'avoid-reinterprets',
        'flatten',
        'simplify-locals-notee-nostructure',
        'remove-unused-names',
        'merge-blocks',
        'coalesce-locals',
        'reorder-locals',
        'vacuum',
        'remove-unused-module-elements',
    ]);

    // Convert functions to methods
    for (let i = 0; i < mod.getNumFunctions(); i++) {
        let func = mod.getFunctionByIndex(i);
        convertFunction(func);
    }

    // Internal functions o' doom
    {
        // wasm$clz32 helper
        let method = abc.method({
            name: abc.string('clz32'),
            return_type: intName,
            param_types: [intName]
        });

        let op = abc.methodBuilder();
        // var n:int = 32;
        op.pushbyte(32);
        op.setlocal_2();

        for (let bits of [16, 8, 4, 2]) {
            // var y:int = x >> bits;
            op.getlocal_1();
            op.pushbyte(bits);
            op.rshift();
            op.setlocal_3();
            // if (y) {
            let endif = new Label();
            op.getlocal_3();
            op.iffalse(endif);
            //   n -= bits;
            op.getlocal_2();
            op.pushbyte(bits);
            op.subtract_i();
            op.setlocal_2();
            //   x = y;
            op.getlocal_3();
            op.setlocal_1();
            op.label(endif);
            // }
        }

        // y = x >> 1
        op.getlocal_1();
        op.pushbyte(1);
        op.rshift();
        op.setlocal_3();
        // if (y) {
        let endif = new Label();
        op.getlocal_3();
        op.iffalse(endif);
        // return n - 2
        op.getlocal_2();
        op.pushbyte(2);
        op.subtract_i();
        op.returnvalue();
        op.label(endif);
        // }
        // return n - x
        op.getlocal_2();
        op.getlocal_1();
        op.subtract_i();
        op.returnvalue();

        let body = abc.methodBody({
            method,
            local_count: op.max_local + 1,
            init_scope_depth: 3,
            max_scope_depth: 3,
            code: op.toBytes(),
            max_stack: op.max_stack
        });

        instanceTraits.push(abc.trait({
            name: clz32Name,
            kind: Trait.Method | Trait.Final,
            method
        }));
    }
    {
        // wasm$memory_grow helper
        let method = abc.method({
            name: abc.string('memory_grow'),
            return_type: intName,
            param_types: [intName]
        });

        let op = abc.methodBuilder();
        // var old:int = this.wasm$memory.length >>> 16;
        op.getlocal_0();
        op.getproperty(memoryName);
        op.getproperty(lengthName);
        op.pushbyte(16);
        op.urshift();
        op.convert_i();
        op.setlocal_2();

        // @fixme enforce maximums, etc.
        // this.wasm$memory.length = (arg1 + old) << 16;
        op.getlocal_0();
        op.getproperty(memoryName);
        op.getlocal_1();
        op.getlocal_2();
        op.add_i();
        op.pushbyte(16);
        op.lshift();

        op.setproperty(lengthName);

        // Reattach domain memory after growth
        // This may or may not be necessary
        attachDomainMemory(op);

        // return old;
        op.getlocal_2();
        op.returnvalue();

        let body = abc.methodBody({
            method,
            local_count: op.max_local + 1,
            init_scope_depth: 3,
            max_scope_depth: 3,
            code: op.toBytes(),
        });

        instanceTraits.push(abc.trait({
            name: memoryGrowName,
            kind: Trait.Method | Trait.Final,
            method
        }));
    }
    {
        // wasm$memory_size helper
        let method = abc.method({
            name: abc.string('memory_size'),
            return_type: intName,
            param_types: []
        });

        let op = abc.methodBuilder();
        // this.wasm$memory.length >>> 16
        op.getlocal_0();
        op.getproperty(memoryName);
        op.getproperty(lengthName);

        op.pushbyte(16);
        op.urshift();
        op.convert_i();
        op.returnvalue();

        let body = abc.methodBody({
            method,
            local_count: op.max_local + 1,
            init_scope_depth: 3,
            max_scope_depth: 3,
            code: op.toBytes(),
        });

        instanceTraits.push(abc.trait({
            name: memorySizeName,
            kind: Trait.Method | Trait.Final,
            method
        }));
    }
    {
        // wasm$memory_init helper
        let method = abc.method({
            name: abc.string('memory_init'),
            return_type: voidName,
            param_types: [intName, stringName]
        });

        let op = abc.methodBuilder();
        // local1 = byteOffset
        // local2 = str

        // local3 = i = 0
        op.pushbyte(0);
        op.setlocal_3();

        // local4 = len = str.length
        op.getlocal_2();
        op.getproperty(lengthName);
        op.convert_i();
        op.setlocal(4);

        let loopStart = new Label();
        let loopEnd = new Label();
        op.label(loopStart);

        // if not i < len, jump to loopEnd
        op.getlocal_3();
        op.getlocal(4);
        op.ifnlt(loopEnd);

        // si8(str.charCodeAt(i), byteOffset + i)
        op.getlocal_2(); // str
        op.getlocal_3(); // i
        op.callproperty(charCodeAtName, 1);
        op.convert_i();
        op.getlocal_1();
        op.getlocal_3();
        op.add_i();
        op.si8();

        // i++
        op.inclocal_i(3);

        // Back to start of loop
        op.jump(loopStart);

        op.label(loopEnd);

        op.returnvoid();

        abc.methodBody({
            method,
            local_count: op.max_local + 1,
            init_scope_depth: 3,
            max_scope_depth: 3,
            code: op.toBytes(),
            max_stack: op.max_stack
        });

        instanceTraits.push(abc.trait({
            name: memoryInitName,
            kind: Trait.Method | Trait.Final,
            method
        }));
    }

    // Class static initializer
    let cinit = abc.method({
        name: abc.string('wasm2swf_cinit'),
        return_type: voidName,
        param_types: [],
    });
    let cinitBody = abc.methodBuilder();
    cinitBody.returnvoid();
    abc.methodBody({
        method: cinit,
        local_count: cinitBody.max_local + 1,
        init_scope_depth: 3,
        max_scope_depth: 3,
        code: cinitBody.toBytes()
    });
    let classi = abc.addClass(cinit, classTraits);

    // Instance constructor
    let iinit = abc.method({
        name: abc.string('wasm2swf_iinit'),
        return_type: voidName,
        param_types: [objectName],
    });

    let iinitBody = abc.methodBuilder();
    iinitBody.getlocal_0();
    iinitBody.coerce(instanceName);
    iinitBody.setlocal_0();

    iinitBody.getlocal_0();
    iinitBody.constructsuper(0);

    // Initialize globals
    for (let glob of Object.values(knownGlobals)) {
        let globalInfo = glob.info;
        if (globalInfo) {
            let init = globalInfo.init;
            if (!init) continue;
            let info = binaryen.getExpressionInfo(init);
            if (info.id === binaryen.ConstId) {
                iinitBody.getlocal_0();
                switch (info.type) {
                    case binaryen.i32:
                        iinitBody.pushint_value(info.value);
                        break;
                    case binaryen.f32:
                    case binaryen.f64:
                        iinitBody.pushdouble(abc.double(info.value));
                        break;
                    default:
                        throw new Error('Unexpected constant initializer type');
                }
                iinitBody.initproperty(qname(privatens, 'global$' + globalInfo.name));
            } else {
                throw new Error('Non-constant global initializer');
            }
        }
    }

    // Initialize the memory
    iinitBody.getlocal_0();
    iinitBody.getlex(byteArrayName);
    iinitBody.construct(0);
    iinitBody.dup();
    iinitBody.pushstring(abc.string('littleEndian'));
    iinitBody.setproperty(qname(pubns, 'endian'));
    iinitBody.dup();
    iinitBody.pushint_value(2 ** 24); // default to 16 MiB memory for the moment
    iinitBody.setproperty(qname(pubns, 'length'));
    iinitBody.initproperty(memoryName); // on this

    // Set it as domain memory
    function attachDomainMemory(op) {
        let flashsystemns = ns(Namespace.Namespace, 'flash.system');
        let appDomainName = qname(flashsystemns, 'ApplicationDomain');

        // @fixme maybe save the domain for handier access
        op.getlex(appDomainName);
        op.getproperty(qname(pubns, 'currentDomain'));
        op.coerce(appDomainName);

        op.getlocal_0();
        op.getproperty(memoryName); // on this

        op.setproperty(qname(pubns, 'domainMemory')); // on ApplicationDomain.currentDomain
    }
    attachDomainMemory(iinitBody);

    for (let i = 0; i < mod.getNumMemorySegments(); i++) {
        let segment = mod.getMemorySegmentInfoByIndex(i);

        iinitBody.getlocal_0();
        iinitBody.pushint_value(segment.byteOffset);
        iinitBody.pushstring(abc.string(binaryString(segment.data)));
        iinitBody.callpropvoid(qname(privatens, 'wasm$memory_init'), 2);
    }

    // Initialize the table
    iinitBody.getlocal_0();
    iinitBody.getlex(arrayName);
    iinitBody.construct(0);
    iinitBody.initproperty(tableName);

    // @fixme implement the initializer segments
    // @fixme needs proper accessors added to upstream binaryen.js
    // this is a custom-patched version
    for (let i = 0; i < mod.getNumFunctionTableSegments(); i++) {
        let segment = mod.getFunctionTableSegmentInfoByIndex(i);
        for (let j = 0; j < segment.functions.length; j++) {
            let name = segment.functions[j];
            let funcName = qname(privatens, 'func$' + name);

            let index = segment.offset + j;
            let pubset = abc.namespaceSet([pubns]); // is there a better way to do this?
            let runtimeName = abc.multinameL(pubset);

            iinitBody.getlocal_0();
            iinitBody.getproperty(tableName);
            iinitBody.pushint_value(index);
            iinitBody.getlocal_0();
            iinitBody.getproperty(funcName);
            iinitBody.setproperty(runtimeName);
        }
    }

    // Initialize the import function slots
    for (let info of imports) {
        iinitBody.getlocal_0(); // 'this'
        iinitBody.getlocal_1(); // imports
        iinitBody.getproperty(qname(pubns, info.module)); // imports.env
        iinitBody.getproperty(qname(pubns, info.base));   // imports.env.somethingCool
        iinitBody.initproperty(qname(privatens, 'import$' + info.module + '$' + info.base));
    }

    // Initialize the export object
    iinitBody.getlocal_0(); // 'this'
    let nprops = 0;
    for (let i = 0; i < mod.getNumExports(); i++) {
        let ex = mod.getExportByIndex(i);
        let info = binaryen.getExportInfo(ex);
        //console.log('export', info);
        nprops++;
        let privname;
        switch (info.kind) {
            case binaryen.ExternalGlobal:
                // note we can't get a list of globals yet
                // so this is required to ensure we initialize all exported globals
                // evne if not referenced in methods
                {
                    let globalId = mod.getGlobal(info.value);
                    let globalInfo = binaryen.getGlobalInfo(globalId);

                    let name = qname(privatens, 'global$' + globalInfo.name);
                    let type = qname(pubns, avmType(globalInfo.type));
                    addGlobal(name, type, globalInfo);
                }

                // @fixme this should export a WebAssembly.Global wrapper object
                privname = 'global$' + info.value;
                break;
            case binaryen.ExternalFunction:
                privname = 'func$' + info.value;
                break;
            case binaryen.ExternalMemory:
                // @fixme this should export a WebAssembly.Memory wrapper object
                privname = 'wasm$memory';
                break;
            case binaryen.ExternalTable:
                // @fixme this should export a WebAssembly.Table wrapper object
                privname = 'wasm$table';
                break;
            default: {
                console.error(info);
                throw new Error('unexpected export type');
            }
        }
        let pubname = abc.string(info.name);
        iinitBody.pushstring(pubname)
        iinitBody.getlocal_0(); // 'this'
        iinitBody.getproperty(qname(privatens, privname));
    }
    iinitBody.newobject(nprops);
    iinitBody.initproperty(exportsName);
    iinitBody.returnvoid();

    abc.methodBody({
        method: iinit,
        local_count: iinitBody.max_local + 1,
        init_scope_depth: 3,
        max_scope_depth: 3,
        code: iinitBody.toBytes(),
        max_stack: iinitBody.max_stack
    });

    // @fixme maybe add class and instance data in the same call?
    let className = instanceName;
    abc.instance({
        name: className, // @todo make the namespace specifiable
        super_name: objectName,
        flags: 0,
        iinit,
        traits: instanceTraits,
    });

    // Script initializer
    const init = abc.method({
        name: abc.string('wasm2swf_init'),
        return_type: voidName,
        param_types: [],
    });
    let initBody = abc.methodBuilder();

    // Initialize the Instance class
    initBody.getlocal_0(); // 'this' for pushscope
    initBody.pushscope();
    initBody.findpropstrict(className); // find where to store the class property soon...
    initBody.getlex(objectName); // get base class scope
    initBody.pushscope();
    initBody.getlex(objectName); // get base class
    initBody.newclass(classi);
    initBody.popscope();
    initBody.initproperty(className);

    let scriptTraits = [];
    scriptTraits.push(abc.trait({
        name: className,
        kind: Trait.Class,
        slot_id: 0,
        classi: classi,
    }));

    if (sprite) {
        // We seem to need a Sprite to load a swf
        let flashdisplayns = ns(Namespace.Namespace, 'flash.display');
        let flasheventsns = ns(Namespace.Namespace, 'flash.events');
        let spriteName = qname(flashdisplayns, 'Sprite');
        let wrapperName = qname(pubns, 'Wrapper');

        // Define the Wrapper sprite class

        let cinit = abc.method({
            name: abc.string('Wrapper_cinit'),
            return_type: voidName,
            param_types: []
        });
        let cinitBody = abc.methodBuilder();
        cinitBody.returnvoid();
        abc.methodBody({
            method: cinit,
            local_count: cinitBody.max_local + 1,
            init_scope_depth: 0,
            max_scope_depth: 8,
            code: cinitBody.toBytes(),
        })
        let classi = abc.addClass(cinit, []);

        let iinit = abc.method({
            name: abc.string('Wrapper_iinit'),
            return_type: voidName,
            param_types: []
        });
        let iinitBody = abc.methodBuilder();
        iinitBody.getlocal_0();
        iinitBody.constructsuper(0);
        iinitBody.returnvoid();
        abc.methodBody({
            method: iinit,
            local_count: iinitBody.max_local + 1,
            code: iinitBody.toBytes()
        });

        abc.instance({
            name: wrapperName,
            super_name: spriteName,
            flags: 0,
            iinit,
            traits: [],
        });
    
        // Initialize the Wrapper class
        initBody.getlocal_0(); // 'this' for pushscope
        initBody.pushscope();
        initBody.findpropstrict(className); // find where to store the class property soon...
        initBody.getlex(objectName);
        initBody.pushscope();
        initBody.getlex(qname(flasheventsns, 'EventDispatcher'));
        initBody.pushscope();
        initBody.getlex(qname(flashdisplayns, 'DisplayObject'));
        initBody.pushscope();
        initBody.getlex(qname(flashdisplayns, 'InteractiveObject'));
        initBody.pushscope();
        initBody.getlex(qname(flashdisplayns, 'DisplayObjectContainer'));
        initBody.pushscope();
        initBody.getlex(spriteName); // get base class scope
        initBody.pushscope();
        initBody.getlex(spriteName); // get base class
        initBody.newclass(classi);
        initBody.popscope();
        initBody.popscope();
        initBody.popscope();
        initBody.popscope();
        initBody.popscope();
        initBody.popscope();
        initBody.initproperty(wrapperName);
        
        scriptTraits.push(abc.trait({
            name: wrapperName,
            kind: Trait.Class,
            slot_id: 0,
            classi: classi,
        }));
    }

    initBody.returnvoid();
    abc.methodBody({
        method: init,
        local_count: initBody.max_local + 1,
        init_scope_depth: 0,
        max_scope_depth: 8,
        code: initBody.toBytes(),
    });

    abc.script(init, scriptTraits);

    let bytes = abc.toBytes();
    console.log(`\n\n${bytes.length} bytes of abc`);

    return bytes;
}


function generateSWF(symbols, tags, bytecode) {
    let swf = new SWFFileBuilder();

    swf.header({
        width: 10000,
        height: 7500,
        framerate: 24,
    });

    swf.fileAttributes({
        actionScript3: true,
        useNetwork: true,
    });

    swf.frameLabel('frame1');
    swf.doABC('frame1', bytecode);
    swf.symbolClass(symbols, tags);
    swf.showFrame();
    swf.end();

    return swf.toBytes();
}

let wasm = fs.readFileSync(infile);
let mod = binaryen.readBinary(wasm);
let bytes = convertModule(mod, sprite);

if (saveWat) {
    let buf = (new TextEncoder()).encode(mod.emitText());
    fs.writeFileSync(saveWat, buf);
}

if (outfile.endsWith('.abc')) {
    fs.writeFileSync(outfile, bytes);
} else {
    let classes = ['Instance'];
    let tags = {};
    if (sprite) {
        /*
        classes.push('Wrapper');
        tags.Wrapper = 0;
        tags.Instance = 1;
        */
        classes = ['Wrapper'];
    }
    let swf = generateSWF(classes, tags, bytes);
    fs.writeFileSync(outfile, swf);
}
