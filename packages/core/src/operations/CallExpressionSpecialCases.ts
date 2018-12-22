import { ExecContext } from "../helperFunctions/ExecContext";
import {
  consoleLog,
  consoleError,
  consoleWarn
} from "../helperFunctions/logging";
import {
  regExpContainsNestedGroup,
  countGroupsInRegExp
} from "../regExpHelpers";
import { mapPageHtml } from "../mapPageHtml";
import { safelyReadProperty } from "../util";
import addElOrigin, {
  addOriginInfoToCreatedElement,
  addElAttributeNameOrigin,
  addElAttributeValueOrigin,
  getElAttributeNameOrigin,
  getElAttributeValueOrigin
} from "./domHelpers/addElOrigin";
import mapInnerHTMLAssignment from "./domHelpers/mapInnerHTMLAssignment";
import * as cloneRegExp from "clone-regexp";

function getFnArg(args, index) {
  return args[2][index];
}

export interface SpecialCaseArgs {
  ctx: ExecContext;
  object: any;
  fnArgs: any[];
  logData: any;
  fnArgValues: any[];
  ret: any;
  extraTrackingValues: any;
  runtimeArgs: any;
}

type TraverseObjectCallBack = (
  keyPath: string,
  value: any,
  key: string,
  obj: any
) => void;

function traverseObject(
  traversedObject,
  fn: TraverseObjectCallBack,
  keyPath: any[] = []
) {
  if (traversedObject === null) {
    return;
  }
  Object.entries(traversedObject).forEach(([key, value]) => {
    fn([...keyPath, key].join("."), value, key, traversedObject);
    if (typeof value === "object") {
      traverseObject(value, fn, [...keyPath, key]);
    }
  });
}

export const specialCases = {
  "String.prototype.replace": ({
    ctx,
    object,
    fnArgValues,
    args,
    extraTrackingValues,
    logData
  }) => {
    let index = 0;
    var ret = ctx.knownValues
      .getValue("String.prototype.replace")
      .call(object, fnArgValues[0], function() {
        var argumentsArray = Array.prototype.slice.apply(arguments, []);
        var match = argumentsArray[0];
        var submatches = argumentsArray.slice(1, argumentsArray.length - 2);
        var offset = argumentsArray[argumentsArray.length - 2];
        var string = argumentsArray[argumentsArray.length - 1];

        var newArgsArray = [match, ...submatches, offset, string];
        let replacement;
        let replacementParameter = fnArgValues[1];
        if (["string", "number"].includes(typeof replacementParameter)) {
          let replacementValue = replacementParameter.toString();
          replacementValue = replacementValue.replace(
            new RegExp(
              // I'm using fromCharCode because the string escaping for helperCode
              // doesn't work properly... if it's fixed we can just uses backtick directly
              "\\$([0-9]{1,2}|[$" +
              String.fromCharCode(96) /* backtick */ +
                "&'])",
              "g"
            ),
            function(dollarMatch, dollarSubmatch) {
              var submatchIndex = parseFloat(dollarSubmatch);
              if (!isNaN(submatchIndex)) {
                var submatch = submatches[submatchIndex - 1]; // $n is one-based, array is zero-based
                if (submatch === undefined) {
                  var maxSubmatchIndex = countGroupsInRegExp(getFnArg(args, 0));
                  var submatchIsDefinedInRegExp =
                    submatchIndex < maxSubmatchIndex;

                  if (submatchIsDefinedInRegExp) {
                    submatch = "";
                  } else {
                    submatch = "$" + dollarSubmatch;
                  }
                }
                return submatch;
              } else if (dollarSubmatch === "&") {
                return match;
              } else {
                throw "not handled!!";
              }
            }
          );
          replacement = replacementValue;
        } else {
          throw Error("unhandled replacement param type");
        }

        extraTrackingValues["replacement" + index] = [
          null,
          ctx.createOperationLog({
            operation: ctx.operationTypes.stringReplacement,
            args: {
              value: getFnArg(args, 1)
            },
            astArgs: {},
            result: replacement,
            loc: logData.loc,
            runtimeArgs: {
              start: offset,
              end: offset + match.length
            }
          })
        ];

        index++;
        return replacement;
      });
    var retT = null;
    return [ret, retT];
  },
  "JSON.parse": ({
    fn,
    ctx,
    fnArgValues,
    args,

    logData
  }) => {
    const parsed = fn.call(JSON, fnArgValues[0]);
    var ret, retT;

    traverseObject(parsed, (keyPath, value, key, obj) => {
      const trackingValue = ctx.createOperationLog({
        operation: ctx.operationTypes.jsonParseResult,
        args: {
          json: getFnArg(args, 0)
        },
        result: value,
        runtimeArgs: {
          keyPath: keyPath,
          isKey: false
        },
        loc: logData.loc
      });
      const nameTrackingValue = ctx.createOperationLog({
        operation: ctx.operationTypes.jsonParseResult,
        args: {
          json: getFnArg(args, 0)
        },
        result: key,
        runtimeArgs: {
          keyPath: keyPath,
          isKey: true
        },
        loc: logData.loc
      });
      ctx.trackObjectPropertyAssignment(
        obj,
        key,
        trackingValue,
        nameTrackingValue
      );
    });

    retT = null; // could set something here, but what really matters is the properties

    ret = parsed;
    return [ret, retT];
  }
};

// add tracking values to returned objects
export const specialValuesForPostprocessing = {
  "String.prototype.match": ({
    object,
    ctx,
    logData,
    fnArgValues,
    ret,
    context
  }) => {
    ctx = <ExecContext>ctx;
    if (!Array.isArray(ret)) {
      return;
    }
    let regExp = fnArgValues[0];
    if (!(regExp instanceof RegExp)) {
      consoleLog("non regexp match param, is this possible?");
      return;
    }

    // this will break if inspected code depends on state
    regExp = cloneRegExp(regExp);

    let matches: any[] = [];
    var match;
    while ((match = regExp.exec(object)) != null) {
      matches.push(match);
      if (!regExp.global) {
        // break because otherwise exec will start over at beginning of the string
        break;
      }
    }

    if (!regExp.global) {
      // non global regexp has group match results:
      // /(a)(b)/.exec("abc") => ["ab", "a", "b"], index 0
      let newMatches: any[] = [];

      let index = matches[0].index;
      let fullMatch = matches[0][0];
      let fullMatchRemaining = fullMatch;

      newMatches.push({
        index: index
      });

      let charsRemovedFromFullMatch = 0;

      for (var i = 1; i < matches[0].length; i++) {
        let matchString = matches[0][i];
        if (matchString === undefined) {
          newMatches.push(undefined);
          continue;
        }
        // This can be inaccurate but better than nothing
        let indexOffset = fullMatchRemaining.indexOf(matchString);
        if (indexOffset === -1) {
          debugger;
        }
        newMatches.push({
          index: index + indexOffset + charsRemovedFromFullMatch
        });

        // cut down match against which we do indexOf(), since we know
        // a single location can't get double matched
        // (maybe it could with nested regexp groups but let's not worry about that for now)
        let charsToRemove = 0;
        if (!regExpContainsNestedGroup(regExp)) {
          // nested groups means there can be repetition
          charsToRemove = indexOffset + matchString.length;
        }
        charsRemovedFromFullMatch += charsToRemove;
        fullMatchRemaining = fullMatchRemaining.slice(charsToRemove);
      }
      matches = newMatches;
    }

    if (matches.length < ret.length) {
      debugger;
    }
    ret.forEach((item, i) => {
      if (matches[i] === undefined) {
        return;
      }
      ctx.trackObjectPropertyAssignment(
        ret,
        i.toString(),
        ctx.createOperationLog({
          operation: ctx.operationTypes.matchResult,
          args: {
            input: context
          },
          result: item,
          astArgs: {},
          runtimeArgs: {
            matchIndex: matches[i].index
          },
          loc: logData.loc
        }),
        ctx.createArrayIndexOperationLog(i, logData.loc)
      );
    });
  },
  "String.prototype.split": ({
    object,
    fnArgs,
    ctx,
    logData,
    fnArgValues,
    ret,
    context
  }) => {
    ctx = <ExecContext>ctx;

    const str = object;
    const strT = context[1];

    const array = ret;

    if (!Array.isArray(ret)) {
      // can happen if separator is something like {[Symbol.split]: fn}
      return;
    }

    // TODO: properly track indices where string came from
    // I thought I could do that by just capturing the string
    // and the separator, but the separator can also be a regexp
    ret.forEach((item, i) => {
      ctx.trackObjectPropertyAssignment(
        array,
        i.toString(),
        ctx.createOperationLog({
          operation: ctx.operationTypes.splitResult,
          args: {
            string: [str, strT],
            separator: [fnArgValues[0], fnArgs[0]]
          },
          runtimeArgs: {
            splitResultIndex: i
          },
          result: item,
          astArgs: {},
          loc: logData.loc
        }),
        ctx.createArrayIndexOperationLog(i, logData.loc)
      );
    });
  },
  "Array.prototype.push": ({ object, fnArgs, ctx, logData }) => {
    const arrayLengthBeforePush = object.length - fnArgs.length;
    fnArgs.forEach((arg, i) => {
      const arrayIndex = arrayLengthBeforePush + i;
      ctx.trackObjectPropertyAssignment(
        object,
        arrayIndex,
        arg,
        ctx.createArrayIndexOperationLog(arrayIndex, logData.loc)
      );
    });
    return fnArgs[fnArgs.length - 1];
  },
  "Array.prototype.pop": ({ extraState }) => {
    return extraState.poppedValueTrackingValue;
  },
  "Object.keys": ({ ctx, logData, fnArgValues, ret, retT }) => {
    ret.forEach((key, i) => {
      const trackingValue = ctx.getObjectPropertyNameTrackingValue(
        fnArgValues[0],
        key
      );
      const nameTrackingValue = ctx.createArrayIndexOperationLog(
        i,
        logData.loc
      );
      ctx.trackObjectPropertyAssignment(
        ret,
        i,
        trackingValue,
        nameTrackingValue
      );
    });
    return retT;
  },
  "Object.entries": ({ ctx, logData, fnArgValues, ret, retT }) => {
    const obj = fnArgValues[0];
    ret.forEach((entryArr, i) => {
      const [key, value] = entryArr;
      const valueTv = ctx.getObjectPropertyTrackingValue(obj, key);
      const keyTv = ctx.getObjectPropertyNameTrackingValue(obj, key);
      ctx.trackObjectPropertyAssignment(entryArr, 1, valueTv);
      ctx.trackObjectPropertyAssignment(entryArr, 0, keyTv);
    });
    return retT;
  },
  "Object.assign": ({ ctx, logData, fnArgValues }) => {
    ctx = <ExecContext>ctx;
    const target = fnArgValues[0];
    const sources = fnArgValues.slice(1);
    sources.forEach(source => {
      if (!source || typeof source !== "object") {
        return;
      }
      Object.keys(source).forEach(key => {
        const valueTrackingValue = ctx.createOperationLog({
          operation: ctx.operationTypes.objectAssign,
          args: {
            value: [null, ctx.getObjectPropertyTrackingValue(source, key)],
            call: [null, logData.index]
          },
          result: source[key],
          astArgs: {},
          loc: logData.loc
        });
        const nameTrackingValue = ctx.createOperationLog({
          operation: ctx.operationTypes.objectAssign,
          args: {
            value: [null, ctx.getObjectPropertyNameTrackingValue(source, key)],
            call: [null, logData.index]
          },
          result: key,
          astArgs: {},
          loc: logData.loc
        });

        ctx.trackObjectPropertyAssignment(
          target,
          key,
          valueTrackingValue,
          nameTrackingValue
        );
      });
    });
  },
  "Array.prototype.shift": ({ object, extraState, ctx }) => {
    // Note: O(n) is not very efficient...
    const array = object;
    for (var i = 0; i < array.length; i++) {
      ctx.trackObjectPropertyAssignment(
        array,
        i.toString(),
        ctx.getObjectPropertyTrackingValue(array, i + 1),
        ctx.getObjectPropertyNameTrackingValue(array, i + 1)
      );
    }

    return extraState.shiftedTrackingValue;
  },
  "Array.prototype.unshift": ({
    object,
    extraState,
    ctx,
    retT,
    fnArgs,
    fnArgValues
  }) => {
    // Note: O(n) is not very efficient...
    const array = object;
    const unshiftedItems = fnArgValues[0];
    for (let i = unshiftedItems.length; i < array.length; i++) {
      ctx.trackObjectPropertyAssignment(
        array,
        i.toString(),
        ctx.getObjectPropertyTrackingValue(array, i - unshiftedItems.length),
        ctx.getObjectPropertyNameTrackingValue(array, i - unshiftedItems.length)
      );
    }

    for (let i = 0; i <= unshiftedItems.length; i++) {
      ctx.trackObjectPropertyAssignment(array, i, fnArgs[i], null);
    }

    return extraState.shiftedTrackingValue;
  },
  "Array.prototype.slice": ({
    object,

    ctx,
    logData,
    fnArgValues,
    ret
  }) => {
    ctx = <ExecContext>ctx;
    const resultArray = ret;
    const inputArray = object;

    let startIndex, endIndex;

    if (fnArgValues.length === 0) {
      startIndex = 0;
      endIndex = resultArray.length;
    } else {
      startIndex = fnArgValues[0];
      if (startIndex < 0) {
        startIndex = inputArray.length + startIndex;
      }
      endIndex = fnArgValues[0];
      if (endIndex < 0) {
        endIndex = inputArray.length + endIndex;
      }
    }

    function makeTrackingValue(result, valueTv) {
      return ctx.createOperationLog({
        operation: ctx.operationTypes.arraySlice,
        args: {
          value: [null, valueTv],
          call: [null, logData.index]
        },
        result: result,
        astArgs: {},
        loc: logData.loc
      });
    }

    resultArray.forEach((item, i) => {
      // todo: create slice call action
      const originalIndex = i + startIndex;
      ctx.trackObjectPropertyAssignment(
        resultArray,
        i.toString(),
        makeTrackingValue(
          item,
          ctx.getObjectPropertyTrackingValue(
            inputArray,
            originalIndex.toString()
          )
        ),
        makeTrackingValue(
          i,
          ctx.getObjectPropertyNameTrackingValue(
            inputArray,
            originalIndex.toString()
          )
        )
      );
    });
  },
  "Array.prototype.splice": ({ object, ctx, logData, fnArgValues, ret }) => {
    ctx = <ExecContext>ctx;
    const resultArray = ret;
    const inputArray = object;

    let startIndex, deleteCount;
    if (fnArgValues.length >= 2) {
      startIndex = fnArgValues[0];
      deleteCount = fnArgValues[1];
    }

    resultArray.forEach((value, i) => {
      const originalIndex = i + startIndex;
      const tv = ctx.getObjectPropertyTrackingValue(
        inputArray,
        originalIndex.toString()
      );

      ctx.trackObjectPropertyAssignment(
        resultArray,
        i.toString(),
        ctx.createOperationLog({
          operation: ctx.operationTypes.arraySplice,
          args: {
            value: [null, tv],
            call: [null, logData.index]
          },
          result: value,
          astArgs: {},
          loc: logData.loc
        })
      );
    });

    // if (fnArgValues.length === 0) {
    //   startIndex = 0;
    //   endIndex = resultArray.length;
    // } else {
    //   startIndex = fnArgValues[0];
    //   if (startIndex < 0) {
    //     startIndex = inputArray.length + startIndex;
    //   }
    //   endIndex = fnArgValues[0];
    //   if (endIndex < 0) {
    //     endIndex = inputArray.length + endIndex;
    //   }
    // }
  },
  "Array.prototype.join": ({
    object,
    fnArgs,
    ctx,
    logData,

    retT,
    extraTrackingValues
  }) => {
    for (var i = 0; i < object.length; i++) {
      let arrayValueTrackingValue = ctx.getObjectPropertyTrackingValue(
        object,
        i
      );
      if (!arrayValueTrackingValue) {
        arrayValueTrackingValue = ctx.createOperationLog({
          operation: ctx.operationTypes.untrackedValue,
          args: {},
          astArgs: {},
          runtimeArgs: {
            type: "Unknown Array Join Value"
          },
          result: object[i],
          loc: logData.loc
        });
      }
      extraTrackingValues["arrayValue" + i] = [
        null, // not needed, avoid object[i] lookup which may have side effects
        arrayValueTrackingValue
      ];
    }
    if (fnArgs[0]) {
      extraTrackingValues["separator"] = [null, fnArgs[0]];
    } else {
      extraTrackingValues["separator"] = [
        null,
        ctx.createOperationLog({
          operation: ctx.operationTypes.defaultArrayJoinSeparator,
          args: {},
          astArgs: {},
          result: ",",
          loc: logData.loc
        })
      ];
    }
    return retT;
  },
  "Array.prototype.concat": ({
    object,
    fnArgs,
    ctx,
    logData,
    fnArgValues,
    ret
  }) => {
    const concatValues = [object, ...fnArgValues];
    let i = 0;
    concatValues.forEach((concatValue, valueIndex) => {
      function trackProp(i, value, trackingValue) {
        ctx.trackObjectPropertyAssignment(
          ret,
          i.toString(),
          ctx.createOperationLog({
            operation: ctx.operationTypes.arrayConcat,
            args: {
              value: [null, trackingValue]
            },
            result: value,
            loc: logData.loc
          }),
          ctx.createArrayIndexOperationLog(i, logData.loc)
        );
      }

      if (Array.isArray(concatValue)) {
        concatValue.forEach((arrayValue, indexInOriginalArray) => {
          trackProp(
            i,
            arrayValue,
            ctx.getObjectPropertyTrackingValue(
              concatValue,
              indexInOriginalArray.toString()
            )
          );
          i++;
        });
      } else {
        trackProp(i, concatValue, fnArgs[valueIndex - 1]);
        i++;
      }
    });
  },
  "Array.prototype.map": ({ extraState, ret, ctx, logData }) => {
    const { mapResultTrackingValues } = extraState;
    mapResultTrackingValues.forEach((tv, i) => {
      ctx.trackObjectPropertyAssignment(
        ret,
        i.toString(),
        mapResultTrackingValues[i],
        ctx.createArrayIndexOperationLog(i, logData.loc)
      );
    });
  },
  "Array.prototype.reduce": ({ extraState }) => {
    return extraState.reduceResultTrackingValue;
  },
  "Array.prototype.filter": ({ extraState, ctx, ret, object, logData }) => {
    let resultArrayIndex = 0;
    object.forEach(function(originalArrayItem, originalArrayIndex) {
      if (extraState.filterResults[originalArrayIndex]) {
        ctx.trackObjectPropertyAssignment(
          ret,
          resultArrayIndex,
          ctx.getObjectPropertyTrackingValue(object, originalArrayIndex),
          ctx.createArrayIndexOperationLog(resultArrayIndex, logData.loc)
        );

        resultArrayIndex++;
      }
    });
  },
  "document.createElement": ({
    fnArgs,

    ret
  }) => {
    addOriginInfoToCreatedElement(ret, fnArgs[0], "document.createElement");
  },
  "document.createTextNode": ({
    fnArgs,

    ret
  }) => {
    addElOrigin(ret, "textValue", {
      trackingValue: fnArgs[0]
    });
  },
  "document.createComment": ({ fnArgs, ret }) => {
    addElOrigin(ret, "textValue", {
      trackingValue: fnArgs[0]
    });
  },
  "HTMLElement.prototype.cloneNode": ({ ret, object, fnArgs, fnArgValues }) => {
    const isDeep = !!fnArgValues[0];
    processClonedNode(ret, object);
    function processClonedNode(cloneResult, sourceNode) {
      if (sourceNode.__elOrigin) {
        if (safelyReadProperty(sourceNode, "nodeType") === Node.ELEMENT_NODE) {
          ["openingTagStart", "openingTagEnd", "closingTag"].forEach(
            originName => {
              if (sourceNode.__elOrigin[originName]) {
                addElOrigin(
                  cloneResult,
                  originName,
                  sourceNode.__elOrigin[originName]
                );
              }
            }
          );

          for (var i = 0; i < sourceNode.attributes.length; i++) {
            const attr = sourceNode.attributes[i];
            const nameOrigin = getElAttributeNameOrigin(sourceNode, attr.name);
            const valueOrigin = getElAttributeValueOrigin(
              sourceNode,
              attr.name
            );
            if (nameOrigin) {
              addElAttributeNameOrigin(cloneResult, attr.name, nameOrigin);
            }
            if (valueOrigin) {
              addElAttributeValueOrigin(cloneResult, attr.name, valueOrigin);
            }
          }
        } else if (
          safelyReadProperty(sourceNode, "nodeType") === Node.TEXT_NODE
        ) {
          addElOrigin(
            cloneResult,
            "textValue",
            sourceNode.__elOrigin.textValue
          );
        } else if (
          safelyReadProperty(sourceNode, "nodeType") === Node.COMMENT_NODE
        ) {
          addElOrigin(
            cloneResult,
            "textValue",
            sourceNode.__elOrigin.textValue
          );
        } else {
          consoleWarn("unhandled cloneNode");
        }
      }
      if (safelyReadProperty(sourceNode, "nodeType") === Node.ELEMENT_NODE) {
        if (isDeep) {
          sourceNode.childNodes.forEach((childNode, i) => {
            processClonedNode(cloneResult.childNodes[i], childNode);
          });
        }
      }
    }
  },
  "HTMLElement.prototype.setAttribute": ({ object, fnArgs, fnArgValues }) => {
    const [attrNameArg, attrValueArg] = fnArgs;
    let attrName = fnArgValues[0];
    addElAttributeNameOrigin(object, attrName, {
      trackingValue: attrNameArg
    });
    addElAttributeValueOrigin(object, attrName, {
      trackingValue: attrValueArg
    });
  },
  "HTMLElement.prototype.insertAdjacentHTML": ({
    object,
    fnArgs,
    fnArgValues
  }) => {
    const position = fnArgValues[0].toLowerCase();
    if (position !== "afterbegin") {
      consoleLog("Not tracking insertAdjacentHTML at", position);
      return;
    }

    var el = object;

    const html = fnArgValues[1];

    const helperDiv = document.createElement("div");
    helperDiv.innerHTML = html;
    const nodeAddedCount = helperDiv.childNodes.length;
    var childNodesBefore = Array.from(el.childNodes).slice(nodeAddedCount);

    mapInnerHTMLAssignment(
      el,
      [html, fnArgs[1]],
      "insertAdjacentHTML",
      undefined,
      undefined,
      childNodesBefore
    );
  },
  "DOMParser.prototype.parseFromString": ({ fnArgValues, fnArgs, ret }) => {
    const html = fnArgValues[0];
    const htmlArg = [html, fnArgs[0]];

    const doc = ret;

    mapPageHtml(doc, html, fnArgs[0], "parseFromString");
  },
  "JSON.stringify": ({
    object,
    fnArgs,
    ctx,
    logData,
    fnArgValues,
    ret,
    runtimeArgs,
    extraTrackingValues
  }: SpecialCaseArgs) => {
    const stringifiedObject = fnArgValues[0];
    const jsonIndexToTrackingValue = {};
    runtimeArgs.jsonIndexToTrackingValue = jsonIndexToTrackingValue;
    const jsonString = ret;
    if (!jsonString) {
      // e.g. return value can be undefined when pass a class into JSON.stringify
      return;
    }
    traverseObject(
      stringifiedObject,
      (keyPath, value, key, traversedObject) => {
        const jsonKeyIndex = ret.indexOf('"' + key + '"') + "'".length;
        jsonIndexToTrackingValue[
          jsonKeyIndex
        ] = ctx.getObjectPropertyNameTrackingValue(traversedObject, key);
        let jsonValueIndex = jsonKeyIndex + '"":'.length + key.length;
        if (jsonString[jsonValueIndex] === '"') {
          jsonValueIndex++;
        }

        jsonIndexToTrackingValue[
          jsonValueIndex
        ] = ctx.getObjectPropertyTrackingValue(traversedObject, key);
      }
    );
  }
};