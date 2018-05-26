import * as OperationTypes from "./OperationTypes";
import * as t from "@babel/types";
import {
  createOperation,
  ignoredArrayExpression,
  ignoredStringLiteral,
  getLastOperationTrackingResultCall,
  ignoredNumericLiteral,
  isInIdOfVariableDeclarator,
  isInLeftPartOfAssignmentExpression,
  trackingIdentifierIfExists,
  ignoredCallExpression,
  ignoreNode,
  runIfIdentifierExists,
  createSetMemoValue,
  createGetMemoValue,
  createGetMemoTrackingValue,
  getLastOpValue,
  ignoredIdentifier,
  ignoredObjectExpression
} from "./babelPluginHelpers";
import OperationLog from "./helperFunctions/OperationLog";
import { getLastOperationValueResult } from "./FunctionNames";

interface TraversalStep {
  charIndex: number;
  operationLog: any;
}

function createNode(args, astArgs = null) { }

interface Operations {
  [key: string]: {
    createNode?: (args?: any, astArgs?: any, loc?: any) => any;
    visitor?: any;
    exec?: any;
    arrayArguments?: string[];
    getArgumentsArray?: any;
    traverse?: (operationLog: any, charIndex: number) => TraversalStep;
  };
}

const operations: Operations = {
  memberExpression: {
    exec: (args, astArgs, ctx) => {
      var ret;
      var object = args.object[0];
      var objectT = args.object[1];
      var propertyName = args.propName[0];
      ret = object[propertyName];

      let trackingValue = ctx.getObjectPropertyTrackingValue(object, propertyName)
      if (object === ctx.global.localStorage) {
        trackingValue = ctx.createOperationLog({
          operation: ctx.operationTypes.localStorageValue,
          args: {
            propertyName: args.propName
          },
          astArgs: {},
          result: ret
        })
      }

      ctx.extraArgTrackingValues = {
        propertyValue: [
          ret,
          trackingValue
        ]
      }

      ctx.lastMemberExpressionResult = [object, objectT];

      return ret;
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.extraArgs.propertyValue,
        charIndex: charIndex
      };
    },
    visitor(path) {
      if (isInLeftPartOfAssignmentExpression(path)) {
        return;
      }
      if (path.parent.type === "UpdateExpression") {
        return;
      }

      // todo: dedupe this code
      var property;
      if (path.node.computed === true) {
        property = path.node.property;
      } else {
        if (path.node.property.type === "Identifier") {
          property = t.stringLiteral(path.node.property.name);
          property.loc = path.node.property.loc;
        }
      }

      const op = this.createNode({
        object: [path.node.object, getLastOperationTrackingResultCall],
        propName: [property, getLastOperationTrackingResultCall]
      }, {}, path.node.loc);

      return op;
    }
  },
  binaryExpression: {
    visitor(path) {
      if (!["+", "-", "/", "*"].includes(path.node.operator)) {
        return;
      }
      return this.createNode(
        {
          left: [path.node.left, getLastOperationTrackingResultCall],
          right: [path.node.right, getLastOperationTrackingResultCall]
        },
        { operator: ignoredStringLiteral(path.node.operator) },
        path.node.loc
      );
    },
    traverse(operationLog, charIndex) {
      const { operator } = operationLog.astArgs;
      const { left, right } = operationLog.args;
      if (operator == "+") {
        if (
          typeof left.result.type === "string" &&
          typeof right.result.type === "string"
        ) {
          if (charIndex < left.result.length) {
            return {
              operationLog: left,
              charIndex: charIndex
            };
          } else {
            return {
              operationLog: right,
              charIndex: charIndex - left.result.length
            };
          }
        } else {
          console.log("todo");
        }
      } else {
        console.log("todo binexp operator");
      }
      throw "aaa";
    },
    exec: (args, astArgs, ctx) => {
      var { left, right } = args;
      var ret;
      left = left[0];
      right = right[0];

      var { operator } = astArgs;
      if (operator === "+") {
        ret = left + right;
      } else if (operator === "-") {
        ret = left - right;
      } else if (operator === "*") {
        ret = left * right;
      } else if (operator === "/") {
        ret = left / right;
      } else {
        throw Error("unknown bin exp operator: " + operator);
      }

      return ret;
    }
  },
  localStorageValue: {

  },
  conditionalExpression: {
    exec: (args, astArgs, ctx) => {
      return args.result[0];
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.result,
        charIndex
      };
    },
    visitor(path) {
      var saveTestValue = createSetMemoValue(
        "lastConditionalExpressionTest",
        path.node.test,
        getLastOperationTrackingResultCall
      );
      var saveConsequentValue = createSetMemoValue(
        "lastConditionalExpressionResult",
        path.node.consequent,
        getLastOperationTrackingResultCall
      );
      var saveAlernativeValue = createSetMemoValue(
        "lastConditionalExpressionResult",
        path.node.alternate,
        getLastOperationTrackingResultCall
      );
      var operation = this.createNode({
        test: [
          createGetMemoValue("lastConditionalExpressionTest"),
          createGetMemoTrackingValue("lastConditionalExpressionTest")
        ],
        result: [
          ignoreNode(
            t.conditionalExpression(
              createGetMemoValue("lastConditionalExpressionTest"),
              saveConsequentValue,
              saveAlernativeValue
            )
          ),
          createGetMemoTrackingValue("lastConditionalExpressionResult")
        ]
      });
      path.replaceWith(t.sequenceExpression([saveTestValue, operation]));
    }
  },
  stringReplacement: {

  },
  callExpression: {
    exec: (args, astArgs, ctx) => {
      var i = 0;
      var arg;
      var fnArgs = [];
      var fnArgValues = [];
      while (true) {
        var argKey = "arg" + i;
        if (!(argKey in args)) {
          break;
        }
        arg = args[argKey];
        fnArgValues.push(arg[0]);
        fnArgs.push(
          ctx.createOperationLog({
            operation: ctx.operationTypes.functionArgument,
            args: {
              value: arg
            },
            astArgs: {},
            result: arg[0]
          })
        );
        i++;
      }

      ctx.argTrackingInfo = fnArgs;

      var fn = args.function[0];
      var object = args.context[0];

      const extraTrackingValues: any = {}

      var ret
      let retT = null
      if (astArgs.isNewExpression) {
        let thisValue = null // overwritten inside new()
        ret = new (Function.prototype.bind.apply(args.function[0], [thisValue, ...fnArgValues]))
        retT = ctx.createOperationLog({
          operation: ctx.operationTypes.newExpressionResult,
          args: {},
          astArgs: {},
          result: {},
        })
      } else if (fn === ctx.nativeFunctions.stringPrototypeReplace
        &&
        ["string", "number"].includes(typeof fnArgValues[1])) {


        let index = 0
        ret = ctx.nativeFunctions.stringPrototypeReplace.call(
          object,
          fnArgValues[0],
          function () {
            var argumentsArray = Array.prototype.slice.apply(arguments, [])
            var match = argumentsArray[0];
            var submatches = argumentsArray.slice(1, argumentsArray.length - 2)
            var offset = argumentsArray[argumentsArray.length - 2]
            var string = argumentsArray[argumentsArray.length - 1]

            const replacement = fnArgValues[1].toString()

            extraTrackingValues["replacement" + index] = [null, ctx.createOperationLog({
              operation: ctx.operationTypes.stringReplacement,
              args: {
                value: args.arg1
              },
              astArgs: {},
              result: replacement,
              runtimeArgs: {
                start: offset,
                end: offset + match.length,
              }
            })]

            index++
            return replacement
          }
        )
        retT = null
      } else if (fn === ctx.nativeFunctions.jsonParse) {
        const parsed = ctx.nativeFunctions.jsonParse.call(this, fnArgValues[0])

        function traverseObject(obj, fn, keyPath = []) {
          Object.entries(obj).forEach(([key, value]) => {
            fn([...keyPath, key].join("."), value, key, obj)
            if (typeof value === "object") {
              traverseObject(value, fn, [...keyPath, key])
            }
          })
        }

        traverseObject(parsed, (keyPath, value, key, obj) => {

          const trackingValue = ctx.createOperationLog({
            operation: ctx.operationTypes.jsonParseResult,
            args: {
              json: args.arg0
            },
            result: value,
            runtimeArgs: {
              keyPath: keyPath
            }
          })
          ctx.trackObjectPropertyAssignment(obj, key, trackingValue)
        })

        retT = null // could set something here, but what really matters is the properties

        ret = parsed
      } else {
        if (fn === ctx.nativeFunctions.stringPrototypeReplace) {
          console.log("unhandled string replace call")
        }
        const lastReturnStatementResultBeforeCall = ctx.lastReturnStatementResult && ctx.lastReturnStatementResult[1]
        ret = fn.apply(object, fnArgValues);
        ctx.argTrackingInfo = null
        const lastReturnStatementResultAfterCall = ctx.lastReturnStatementResult && ctx.lastReturnStatementResult[1]
        // Don't pretend to have a tracked return value if an uninstrumented function was called
        // (not 100% reliable e.g. if the uninstrumented fn calls an instrumented fn)
        if (ctx.lastOperationType === "returnStatement" && lastReturnStatementResultAfterCall !== lastReturnStatementResultBeforeCall) {
          retT = ctx.lastReturnStatementResult && ctx.lastReturnStatementResult[1]
        }
      }


      extraTrackingValues.returnValue = [ret, retT] // pick up value from returnStatement

      ctx.extraArgTrackingValues = extraTrackingValues

      return ret;
    },
    traverse(operationLog, charIndex) {
      var knownFunction = operationLog.args.function.result.knownValue;
      if (knownFunction) {
        switch (knownFunction) {
          case "String.prototype.slice":
            return {
              operationLog: operationLog.args.context,
              charIndex: charIndex + operationLog.args.arg0.result.primitive
            };
          case "String.prototype.replace":
            // I'm not 100% confident about this code, but it works for now

            class ValueMapV2 {
              parts = []
              originalString = ""

              constructor(originalString: string) {
                this.originalString = originalString
              }

              push(fromIndexInOriginal, toIndexInOriginal, operationLog, resultString, isPartOfSubject = false) {
                this.parts.push({
                  fromIndexInOriginal,
                  toIndexInOriginal,
                  operationLog,
                  resultString,
                  isPartOfSubject
                })
              }

              getAtResultIndex(indexInResult) {
                let resultString = ""
                let part = null
                for (var i = 0; i < this.parts.length; i++) {
                  part = this.parts[i]
                  resultString += part.resultString
                  if (resultString.length > indexInResult) {
                    break;
                  }
                }

                const resultIndexBeforePart = resultString.length - part.resultString.length
                let charIndex = (part.isPartOfSubject ? part.fromIndexInOriginal : 0) + (indexInResult - resultIndexBeforePart)

                if (charIndex > part.operationLog.result.str.length) {
                  charIndex = part.operationLog.result.str.length - 1
                }

                let operationLog = part.operationLog
                if (operationLog.operation === OperationTypes.stringReplacement) {
                  operationLog = operationLog.args.value
                }
                return {
                  charIndex,
                  operationLog: operationLog
                }

              }

              __debugPrint() {
                let originalString = ""
                let newString = ""
                this.parts.forEach(part => {
                  newString += part.resultString
                  originalString += this.originalString.slice(part.fromIndexInOriginal, part.toIndexInOriginal)
                })
                console.log({ originalString, newString })
              }
            }

            let matchingReplacement = null
            let totalCharCountDeltaBeforeMatch = 0

            const replacements = []
            eachReplacement(operationLog.extraArgs, replacement => {
              replacements.push(replacement)
            })

            const subjectOperationLog = operationLog.args.context

            if (replacements.length === 0) {
              return {
                operationLog: subjectOperationLog,
                charIndex: charIndex
              }
            }

            const valueMap = new ValueMapV2(subjectOperationLog.result.str)

            let currentIndexInSubjectString = 0
            replacements.forEach(replacement => {
              const { start, end } = replacement.runtimeArgs
              let from = currentIndexInSubjectString
              let to = start
              valueMap.push(from, to, subjectOperationLog, subjectOperationLog.result.str.slice(from, to), true)


              valueMap.push(start, end, replacement, replacement.args.value.result.str)
              currentIndexInSubjectString = end
            })
            valueMap.push(
              currentIndexInSubjectString,
              subjectOperationLog.result.str.length,
              subjectOperationLog,
              subjectOperationLog.result.str.slice(currentIndexInSubjectString),
              true
            )

            // valueMap.__debugPrint()

            return valueMap.getAtResultIndex(charIndex)

            function eachReplacement(extraArgs, callback) {
              var index = 0
              while (extraArgs["replacement" + index]) {
                callback(extraArgs["replacement" + index])
                index++
              }
            }
        }
      } else {
        return {
          operationLog: operationLog.extraArgs.returnValue,
          charIndex: charIndex
        };
      }
    },
    visitor(path, isNewExpression = false) {
      const { callee } = path.node;

      var isMemberExpressionCall = callee.type === "MemberExpression";

      var args = [];
      path.node.arguments.forEach(arg => {
        args.push(
          ignoredArrayExpression([arg, getLastOperationTrackingResultCall])
        );
      });

      let executionContext;
      let executionContextTrackingValue;
      if (isMemberExpressionCall) {
        executionContext = ignoredCallExpression(
          "getLastMemberExpressionObjectValue",
          []
        );
        executionContextTrackingValue = ignoredCallExpression(
          "getLastMemberExpressionObjectTrackingValue",
          []
        );
      } else {
        executionContext = t.identifier("undefined");
        executionContextTrackingValue = t.nullLiteral();
      }

      var fnArgs = {};
      args.forEach((arg, i) => {
        fnArgs["arg" + i] = arg;
      });

      var call = operations.callExpression.createNode({
        function: [
          path.node.callee,
          isMemberExpressionCall
            ? getLastOperationTrackingResultCall
            : getLastOperationTrackingResultCall
        ],
        context: [executionContext, executionContextTrackingValue],
        ...fnArgs
      }, {
          isNewExpression: ignoreNode(t.booleanLiteral(isNewExpression))
        }, path.node.callee.loc);

      // todo: would it be better for perf if I updated existing call
      // instead of using replaceWith?
      return call;
    }
  },
  newExpression: {
    visitor(path) {
      return operations.callExpression.visitor(path, true)
    }
  },
  objectProperty: {
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.propertyValue,
        charIndex: charIndex
      };
    }
  },
  objectExpression: {
    exec: (args, astArgs, ctx) => {
      var obj = {};
      var methodProperties = {};

      for (var i = 0; i < args.properties.length; i++) {
        var property = args.properties[i];

        var propertyType = property.type[0];
        var propertyKey = property.key[0];

        if (propertyType === "ObjectProperty") {
          var propertyValue = property.value[0];
          var propertyValueT = property.value[1];

          obj[propertyKey] = propertyValue;

          ctx.trackObjectPropertyAssignment(
            obj,
            propertyKey,
            ctx.createOperationLog({
              operation: "objectProperty",
              args: { propertyValue: [propertyValue, propertyValueT] },
              result: propertyValue,
              astArgs: {}
            })
          );
        } else if (propertyType === "ObjectMethod") {
          var propertyKind = property.kind[0];
          var fn = property.value[0];
          if (!methodProperties[propertyKey]) {
            methodProperties[propertyKey] = {
              enumerable: true,
              configurable: true
            };
          }
          if (propertyKind === "method") {
            obj[propertyKey] = fn;
          } else {
            methodProperties[propertyKey][propertyKind] = fn;
          }
        }
      }
      Object.defineProperties(obj, methodProperties);

      return obj;
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.propertyValue,
        charIndex: charIndex
      };
    },
    visitor(path) {
      path.node.properties.forEach(function (prop) {
        if (prop.key.type === "Identifier") {
          var keyLoc = prop.key.loc;
          prop.key = t.stringLiteral(prop.key.name);
          prop.key.loc = keyLoc;
          // move start a bit to left to compensate for there not
          // being quotes in the original "string", since
          // it's just an identifier
          if (prop.key.loc.start.column > 0) {
            prop.key.loc.start.column--;
          }
        }
      });

      var properties = path.node.properties.map(function (prop) {
        var type = t.stringLiteral(prop.type);
        type.ignore = true;
        if (prop.type === "ObjectMethod") {
          // getters/setters or something like this: obj = {fn(){}}
          var kind = ignoredStringLiteral(prop.kind);
          kind.ignore = true;
          return ignoredObjectExpression({
            type: [type],
            key: [prop.key],
            kind: [kind],
            value: [t.functionExpression(null, prop.params, prop.body)]
          });
        } else {
          return ignoredObjectExpression({
            type: [type],
            key: [prop.key],
            value: [prop.value, getLastOperationTrackingResultCall]
          });
        }
      });

      var call = this.createNode({
        properties
      });

      return call;
    }
  },
  stringLiteral: {
    visitor(path) {
      if (path.parent.type === "ObjectProperty") {
        return;
      }
      return this.createNode({
        value: [ignoredStringLiteral(path.node.value), t.nullLiteral()]
      }, {}, path.node.loc);
    },
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    }
  },
  numericLiteral: {
    visitor(path) {
      if (path.parent.type === "ObjectProperty") {
        return;
      }
      return this.createNode({
        value: [ignoredNumericLiteral(path.node.value), t.nullLiteral()]
      });
    },
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    }
  },
  arrayExpression: {
    arrayArguments: ["elements"],
    exec: (args, astArgs, ctx) => {
      function getArrayArgumentValue(arrayArg) {
        return arrayArg.map(e => e[0]);
      }
      return getArrayArgumentValue(args.elements);
    },
    visitor(path) {
      return this.createNode({
        elements: path.node.elements.map(el =>
          ignoredArrayExpression([el, getLastOperationTrackingResultCall])
        )
      });
    }
  },
  returnStatement: {
    exec: (args, astArgs, ctx) => {
      return args.returnValue[0];
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.returnValue,
        charIndex: charIndex
      };
    },
    visitor(path) {
      path.node.argument = this.createNode({
        returnValue: ignoredArrayExpression([
          path.node.argument,
          getLastOperationTrackingResultCall
        ])
      }, {}, path.node.loc);
    }
  },
  identifier: {
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.value,
        charIndex: charIndex
      };
    },
    visitor(path) {
      if (
        path.parent.type === "FunctionDeclaration" ||
        path.parent.type === "MemberExpression" ||
        path.parent.type === "ObjectProperty" ||
        path.parent.type === "CatchClause" ||
        path.parent.type === "ForInStatement" ||
        path.parent.type === "IfStatement" ||
        path.parent.type === "ForStatement" ||
        path.parent.type === "FunctionExpression" ||
        path.parent.type === "UpdateExpression" ||
        (path.parent.type === "UnaryExpression" &&
          path.parent.operator === "typeof")
      ) {
        return;
      }
      if (
        isInLeftPartOfAssignmentExpression(path) ||
        isInIdOfVariableDeclarator(path)
      ) {
        return;
      }
      if (path.node.name === "globalFn") {
        return;
      }

      path.node.ignore = true;

      return this.createNode({
        value: ignoredArrayExpression([
          path.node,
          trackingIdentifierIfExists(path.node.name)
        ])
      }, {}, path.node.loc);
    }
  },
  memexpAsLeftAssExp: {},
  jsonParseResult: {
    traverse(operationLog, charIndex) {
      // This traversal method is inaccurate but still useful
      // Ideally we should probably have a JSON parser
      const valueReadFromJson = operationLog.result.str
      return {
        operationLog: operationLog.args.json,
        charIndex: operationLog.args.json.result.str.indexOf(valueReadFromJson)
      };

    }
  },
  assignmentExpression: {
    exec: (args, astArgs, ctx) => {
      var ret;
      const assignmentType = args.type[0];
      const operator = astArgs.operator;
      if (assignmentType === "MemberExpression") {
        var obj = args.object[0];
        var propName = args.propertyName[0];
        var objT = args.object[1];
        var propNameT = args.propertyName[1];

        var currentValue = obj[propName];
        var currentValueT = ctx.createOperationLog({
          operation: "memexpAsLeftAssExp",
          args: {
            object: [obj, objT],
            propertyName: [propName, propNameT]
          },
          astArgs: {},
          result: currentValue
        });

        var argument = args.argument[0];
        if (operator === "=") {
          ret = obj[propName] = argument;
        } else if (operator === "+=") {
          ret = obj[propName] = obj[propName] + argument;
        } else {
          throw Error("unknown op " + operator);
        }

        ctx.trackObjectPropertyAssignment(
          obj,
          propName,
          ctx.createOperationLog({
            result: args.argument[0],
            operation: "assignmentExpression",
            args: {
              currentValue: [currentValue, currentValueT],
              argument: args.argument
            },
            argTrackingValues: [currentValueT, args.argument[1]],
            argNames: ["currentValue", "argument"]
          })
        );

        if (obj instanceof HTMLElement && propName === "innerHTML") {

          function tagTypeHasClosingTag(tagName) {
            return document.createElement(tagName).outerHTML.indexOf("></") !== -1
          }



          var htmlEntityRegex = /^\&[#a-zA-Z0-9]+\;/
          var whitespaceRegex = /^[\s]+/
          var tagEndRegex = /^(\s+)\/?>/
          var twoQuoteSignsRegex = /^['"]{2}/

          const config = {
            validateHtmlMapping: true
          }

          var div = document.createElement("div");
          function normalizeHtml(str, tagName) {
            if (tagName !== "SCRIPT" && tagName !== "NOSCRIPT") {
              // convert stuff like & to &amp;
              div.innerHTML = str
              str = div.innerHTML
            }
            if (tagName === "NOSCRIPT") {
              str = str.replace(/\&/g, "&amp;")
              str = str.replace(/</g, "&lt;")
              str = str.replace(/>/g, "&gt;")
            }
            return str;
          }

          var attrDiv = document.createElement("div")
          function normalizeHtmlAttribute(str) {
            attrDiv.setAttribute("sth", str)
            var outerHTML = attrDiv.outerHTML;
            var start = "<div sth='"
            var end = "'></div>"
            return outerHTML.slice(start.length, -end.length)
          }


          function addElOrigin(el, what, trackingValue) {
            const {
              action,
              inputValues,
              value,
              inputValuesCharacterIndex,
              extraCharsAdded,
              offsetAtCharIndex,
              error,
              child,
              children
            } = trackingValue

            if (!el.__elOrigin) {
              el.__elOrigin = {}
            }

            if (what === "replaceContents") {
              el.__elOrigin.contents = children
            } else if (what === "appendChild") {
              if (!el.__elOrigin.contents) {
                el.__elOrigin.contents = []
              }
              el.__elOrigin.contents.push(child)
            } else if (what === "prependChild") {
              if (!el.__elOrigin.contents) {
                el.__elOrigin.contents = []
              }

              el.__elOrigin.contents.push(child)
            } else if (what === "prependChildren") {
              children.forEach((child) => {
                addElOrigin(el, "prependChild", { child })
              })
            } else {
              el.__elOrigin[what] = {
                action,
                trackingValue: inputValues[0][1],
                inputValuesCharacterIndex,
                extraCharsAdded,
                offsetAtCharIndex
              };
            }
          }

          mapInnerHTMLAssignment(obj, args.argument, "assignInnerHTML", 0)

          // tries to describe the relationship between an assigned innerHTML value
          // and the value you get back when reading el.innerHTML.
          // e.g. you could assign "<input type='checkbox' checked>" and get back
          // "<input type='checkbox' checked=''>"
          // essentially this function serializes the elements content and compares it to the
          // assigned value
          function mapInnerHTMLAssignment(el, assignedInnerHTML, actionName, initialExtraCharsValue, contentEndIndex = assignedInnerHTML[0].length, nodesToIgnore = []) {
            var serializedHtml = el.innerHTML
            var forDebuggingProcessedHtml = ""
            var charOffsetInSerializedHtml = 0;
            var charsAddedInSerializedHtml = 0;
            if (initialExtraCharsValue !== undefined) {
              charsAddedInSerializedHtml = initialExtraCharsValue
            }
            var assignedString = assignedInnerHTML[0]
            // if (contentEndIndex === 0) {
            //   contentEndIndex = assignedString.length
            // }
            // if (nodesToIgnore === undefined) {
            //   nodesToIgnore = [];
            // }

            var error = Error() // used to get stack trace, rather than capturing a new one every time
            processNewInnerHtml(el)


            function getCharOffsetInAssignedHTML() {
              return charOffsetInSerializedHtml - charsAddedInSerializedHtml
            }

            function validateMapping(mostRecentOrigin) {
              /*
              if (!config.validateHtmlMapping) {
                return
              }
              var step = {
                originObject: mostRecentOrigin,
                characterIndex: charOffsetInSerializedHtml - 1
              }

              goUpForDebugging(step, function (newStep) {
                if (assignedString[newStep.characterIndex] !== serializedHtml[charOffsetInSerializedHtml - 1]) {
                  // This doesn't necessarily mean anything is going wrong.
                  // For example, you'll get this warning every time you assign an
                  // attribute like this: <a checked>
                  // because it'll be changed into: <a checked="">
                  // and then we compare the last char of the attribute,
                  // which will be 'd' in the assigned string and '"' in
                  // the serialized string
                  // however, I don't think there's ever a reason for this to be
                  // called repeatedly. That would indicate a offset problem that
                  // gets carried through the rest of the assigned string
                  console.warn("strings don't match", assignedString[newStep.characterIndex], serializedHtml[charOffsetInSerializedHtml - 1])
                }
              })
              */
            }

            // get offsets by looking at how the assigned value compares to the serialized value
            // e.g. accounts for differeces between assigned "&" and serialized "&amp;"
            function getCharMappingOffsets(textAfterAssignment, charOffsetAdjustmentInAssignedHtml, tagName) {
              if (charOffsetAdjustmentInAssignedHtml === undefined) {
                charOffsetAdjustmentInAssignedHtml = 0;
              }
              var offsets = [];
              var extraCharsAddedHere = 0;

              for (var i = 0; i < textAfterAssignment.length; i++) {
                offsets.push(-extraCharsAddedHere)
                var char = textAfterAssignment[i];

                var htmlEntityMatchAfterAssignment = textAfterAssignment.substr(i, 30).match(htmlEntityRegex)

                var posInAssignedString = charOffsetInSerializedHtml + i - charsAddedInSerializedHtml + charOffsetAdjustmentInAssignedHtml - extraCharsAddedHere;
                if (posInAssignedString >= contentEndIndex) {
                  // http://stackoverflow.com/questions/38892536/why-do-browsers-append-extra-line-breaks-at-the-end-of-the-body-tag
                  break; // just don't bother for now
                }

                var textIncludingAndFollowingChar = assignedString.substr(posInAssignedString, 30); // assuming that no html entity is longer than 30 chars
                if (char === "\n" && textIncludingAndFollowingChar[0] == "\r") {
                  extraCharsAddedHere--;
                }

                var htmlEntityMatch = textIncludingAndFollowingChar.match(htmlEntityRegex)

                if (tagName === "NOSCRIPT" && htmlEntityMatchAfterAssignment !== null && htmlEntityMatch !== null) {
                  // NOSCRIPT assignments: "&amp;" => "&amp;amp;", "&gt;" => "&amp;gt;"
                  // so we manually advance over the "&amp;"
                  for (var n = 0; n < "amp;".length; n++) {
                    i++;
                    extraCharsAddedHere++;
                    offsets.push(-extraCharsAddedHere)
                  }
                  offsets.push(-extraCharsAddedHere)
                }

                if (htmlEntityMatchAfterAssignment !== null && htmlEntityMatch === null) {
                  // assigned a character, but now it shows up as an entity (e.g. & ==> &amp;)
                  var entity = htmlEntityMatchAfterAssignment[0]
                  for (var n = 0; n < entity.length - 1; n++) {
                    i++
                    extraCharsAddedHere++;
                    offsets.push(-extraCharsAddedHere)
                  }
                }

                if (htmlEntityMatchAfterAssignment === null && htmlEntityMatch !== null) {
                  // assigned an html entity but now getting character back (e.g. &raquo; => »)
                  var entity = htmlEntityMatch[0]
                  extraCharsAddedHere -= entity.length - 1;
                }
              }

              if (offsets.length === 0) {
                offsets = undefined
              }
              return {
                offsets: offsets,
                extraCharsAddedHere: extraCharsAddedHere
              }
            }


            function processNewInnerHtml(el) {
              var children = Array.prototype.slice.apply(el.childNodes, [])
              addElOrigin(el, "replaceContents", {
                action: actionName,
                children: children
              });

              var childNodesToProcess = [].slice.call(el.childNodes);
              childNodesToProcess = childNodesToProcess.filter(function (childNode) {
                var shouldIgnore = nodesToIgnore.indexOf(childNode) !== -1
                return !shouldIgnore
              })

              childNodesToProcess.forEach(function (child) {
                var isTextNode = child.nodeType === 3
                var isCommentNode = child.nodeType === 8
                var isElementNode = child.nodeType === 1
                var isIframe = child

                if (isTextNode) {
                  var text = child.textContent
                  text = normalizeHtml(text, child.parentNode.tagName)
                  var res = getCharMappingOffsets(text, 0, child.parentNode.tagName)
                  var offsets = res.offsets
                  var extraCharsAddedHere = res.extraCharsAddedHere

                  addElOrigin(child, "textValue", {
                    action: actionName,
                    inputValues: [assignedInnerHTML],
                    value: serializedHtml,
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    extraCharsAdded: charsAddedInSerializedHtml,
                    offsetAtCharIndex: offsets,
                    error: error
                  })

                  charsAddedInSerializedHtml += extraCharsAddedHere
                  charOffsetInSerializedHtml += text.length
                  forDebuggingProcessedHtml += text

                  // validateMapping(child.__elOrigin.textValue)
                } else if (isCommentNode) {
                  addElOrigin(child, "commentStart", {
                    action: actionName,
                    inputValues: [assignedInnerHTML],
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    value: serializedHtml
                  })

                  charOffsetInSerializedHtml += "<!--".length
                  forDebuggingProcessedHtml += "<!--";

                  addElOrigin(child, "textValue", {
                    value: serializedHtml,
                    inputValues: [assignedInnerHTML],
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    action: actionName,
                    error: error
                  })
                  charOffsetInSerializedHtml += child.textContent.length
                  forDebuggingProcessedHtml += child.textContent;

                  addElOrigin(child, "commentEnd", {
                    action: actionName,
                    inputValues: [assignedInnerHTML],
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    value: serializedHtml
                  })
                  charOffsetInSerializedHtml += "-->".length
                  forDebuggingProcessedHtml += "-->";
                } else if (isElementNode) {
                  addElOrigin(child, "openingTagStart", {
                    action: actionName,
                    inputValues: [assignedInnerHTML],
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    value: serializedHtml,
                    extraCharsAdded: charsAddedInSerializedHtml,
                    error: error
                  })
                  var openingTagStart = "<" + child.tagName
                  charOffsetInSerializedHtml += openingTagStart.length
                  forDebuggingProcessedHtml += openingTagStart

                  // validateMapping(child.__elOrigin.openingTagStart)

                  for (var i = 0; i < child.attributes.length; i++) {
                    let extraCharsAddedHere = 0;
                    var attr = child.attributes[i]

                    var charOffsetInSerializedHtmlBefore = charOffsetInSerializedHtml

                    var whitespaceBeforeAttributeInSerializedHtml = " "; // always the same
                    var assignedValueFromAttrStartOnwards = assignedString.substr(getCharOffsetInAssignedHTML(), 100)
                    var whitespaceMatches = assignedValueFromAttrStartOnwards.match(whitespaceRegex)

                    var whitespaceBeforeAttributeInAssignedHtml;
                    if (whitespaceMatches !== null) {
                      whitespaceBeforeAttributeInAssignedHtml = whitespaceMatches[0]
                    } else {
                      // something broke, but better to show a broken result than nothing at all
                      if (config.validateHtmlMapping) {
                        console.warn("no whitespace found at start of", assignedValueFromAttrStartOnwards)
                      }
                      whitespaceBeforeAttributeInAssignedHtml = "";
                    }

                    var attrStr = attr.name
                    var textAfterAssignment: any = normalizeHtmlAttribute(attr.textContent)
                    attrStr += "='" + textAfterAssignment + "'"

                    var offsetAtCharIndex = []

                    var extraWhitespaceBeforeAttributeInAssignedHtml = whitespaceBeforeAttributeInAssignedHtml.length - whitespaceBeforeAttributeInSerializedHtml.length
                    extraCharsAddedHere -= extraWhitespaceBeforeAttributeInAssignedHtml

                    offsetAtCharIndex.push(-extraCharsAddedHere); // char index for " " before attr

                    var offsetInAssigned = getCharOffsetInAssignedHTML() + whitespaceBeforeAttributeInAssignedHtml.length

                    // add mapping for attribute name
                    for (var charIndex in attr.name) {
                      offsetAtCharIndex.push(-extraCharsAddedHere)
                    }
                    offsetInAssigned += attr.name.length;

                    var nextCharacters = assignedString.substr(offsetInAssigned, 50);
                    var equalsSignIsNextNonWhitespaceCharacter = /^[\s]*=/.test(nextCharacters)

                    if (!equalsSignIsNextNonWhitespaceCharacter) {
                      if (attr.textContent !== "") {
                        console.warn("empty text content")
                        // debugger
                      }
                      // value of attribute is omitted in original html
                      const eqQuoteQuote: any = '=""'
                      for (var charIndex in eqQuoteQuote) {
                        extraCharsAddedHere++;
                        offsetAtCharIndex.push(-extraCharsAddedHere)
                      }
                    } else {
                      var whitespaceBeforeEqualsSign = nextCharacters.match(/^([\s]*)=/)[1]
                      extraCharsAddedHere -= whitespaceBeforeEqualsSign.length;
                      offsetInAssigned += whitespaceBeforeEqualsSign.length;

                      // map `=` character
                      offsetAtCharIndex.push(-extraCharsAddedHere)
                      offsetInAssigned += "=".length

                      var nextCharacters = assignedString.substr(offsetInAssigned, 50)
                      var whitespaceBeforeNonWhiteSpace = nextCharacters.match(/^([\s]*)[\S]/)[1]
                      extraCharsAddedHere -= whitespaceBeforeNonWhiteSpace.length
                      offsetInAssigned += whitespaceBeforeNonWhiteSpace.length

                      // map `"` character
                      offsetAtCharIndex.push(-extraCharsAddedHere)
                      offsetInAssigned += '"'.length

                      var charOffsetAdjustmentInAssignedHtml = offsetInAssigned - getCharOffsetInAssignedHTML()
                      var res = getCharMappingOffsets(textAfterAssignment, charOffsetAdjustmentInAssignedHtml, child.tagName)

                      if (res.offsets === undefined) {
                        // Pretty sure this can only happen if there is a bug further up, but for now
                        // allow it to happen rather than breaking everything
                        // specifically this was happening on StackOverflow, probably because we don't
                        // support tables yet (turn <table> into <table><tbody>),
                        // but once that is supported this might just fix itself
                        console.warn("No offsets for attribute mapping")
                        for (var i = 0; i < textAfterAssignment.length; i++) {
                          offsetAtCharIndex.push(-extraCharsAddedHere)
                        }
                      }
                      else {
                        res.offsets.forEach(function (offset, i) {
                          offsetAtCharIndex.push(offset - extraCharsAddedHere)
                        })
                        extraCharsAddedHere += res.extraCharsAddedHere
                      }

                      var lastOffset = offsetAtCharIndex[offsetAtCharIndex.length - 1]
                      offsetAtCharIndex.push(lastOffset) // map the "'" after the attribute value
                    }

                    addElOrigin(child, "attribute_" + attr.name, {
                      action: actionName,
                      inputValues: [assignedInnerHTML],
                      value: serializedHtml,
                      inputValuesCharacterIndex: [charOffsetInSerializedHtmlBefore],
                      extraCharsAdded: charsAddedInSerializedHtml,
                      offsetAtCharIndex: offsetAtCharIndex,
                      error: error
                    })

                    charsAddedInSerializedHtml += extraCharsAddedHere

                    charOffsetInSerializedHtml += whitespaceBeforeAttributeInSerializedHtml.length + attrStr.length
                    forDebuggingProcessedHtml += whitespaceBeforeAttributeInSerializedHtml + attrStr

                    var attrPropName = "attribute_" + attr.name;
                    // validateMapping(child.__elOrigin[attrPropName])
                  }

                  var openingTagEnd = ">"

                  var assignedStringFromCurrentOffset = assignedString.substr(getCharOffsetInAssignedHTML(), 200)
                  if (assignedStringFromCurrentOffset === "") {
                    debugger
                  }
                  var matches = assignedStringFromCurrentOffset.match(tagEndRegex);
                  var whitespaceBeforeClosingAngleBracketInAssignedHTML = "";
                  if (matches !== null) {
                    // something like <div > (with extra space)
                    // this char will not show up in the re-serialized innerHTML
                    whitespaceBeforeClosingAngleBracketInAssignedHTML = matches[1]
                  }
                  charsAddedInSerializedHtml -= whitespaceBeforeClosingAngleBracketInAssignedHTML.length;

                  if (!tagTypeHasClosingTag(child.tagName)) {
                    if (assignedString[getCharOffsetInAssignedHTML()] === "/") {
                      // something like <div/>
                      // this char will not show up in the re-serialized innerHTML
                      charsAddedInSerializedHtml -= 1;
                    } else {
                      var explicitClosingTag = "</" + child.tagName.toLowerCase() + ">"
                      var explicitClosingTagAndOpeningTagEnd = ">" + explicitClosingTag
                      if (assignedString.substr(getCharOffsetInAssignedHTML(), explicitClosingTagAndOpeningTagEnd.length).toLowerCase() === explicitClosingTagAndOpeningTagEnd) {
                        // something like <div></div>
                        // this char will not show up in the re-serialized innerHTML
                        charsAddedInSerializedHtml -= explicitClosingTag.length;
                      }
                    }
                  }
                  addElOrigin(child, "openingTagEnd", {
                    action: actionName,
                    inputValues: [assignedInnerHTML],
                    inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                    value: serializedHtml,
                    extraCharsAdded: charsAddedInSerializedHtml,
                    error: error
                  })
                  charOffsetInSerializedHtml += openingTagEnd.length
                  forDebuggingProcessedHtml += openingTagEnd

                  // validateMapping(child.__elOrigin.openingTagEnd)


                  if (child.tagName === "IFRAME") {
                    forDebuggingProcessedHtml += child.outerHTML;
                    charOffsetInSerializedHtml += child.outerHTML.length
                  } else {
                    processNewInnerHtml(child)
                  }

                  if (tagTypeHasClosingTag(child.tagName)) {
                    addElOrigin(child, "closingTag", {
                      action: actionName,
                      inputValues: [assignedInnerHTML],
                      inputValuesCharacterIndex: [charOffsetInSerializedHtml],
                      value: serializedHtml,
                      extraCharsAdded: charsAddedInSerializedHtml,
                      error: error
                    })
                    var closingTag = "</" + child.tagName + ">"
                    charOffsetInSerializedHtml += closingTag.length
                    forDebuggingProcessedHtml += closingTag
                  }

                } else {
                  throw "not handled"
                }
                // console.log("processed", forDebuggingProcessedHtml, assignedInnerHTML.toString().toLowerCase().replace(/\"/g, "'") === forDebuggingProcessedHtml.toLowerCase())

              })
            }

          }

        }
      } else if (assignmentType === "Identifier") {
        ret = args.newValue[0];
      } else {
        throw Error("unknown: " + assignmentType);
      }
      return ret;
    },
    traverse(operationLog, charIndex) {
      return {
        operationLog: operationLog.args.argument,
        charIndex: charIndex
      };
    },
    visitor(path) {
      path.node.ignore = true;

      let operationArguments = {
        type: ignoredArrayExpression([
          ignoredStringLiteral(path.node.left.type),
          t.nullLiteral()
        ])
      };

      let trackingAssignment = null;

      if (path.node.left.type === "MemberExpression") {
        var property;
        if (path.node.left.computed === true) {
          property = path.node.left.property;
        } else {
          property = t.stringLiteral(path.node.left.property.name);
          property.loc = path.node.left.property.loc;
        }

        operationArguments["object"] = [path.node.left.object, t.nullLiteral()];
        operationArguments["propertyName"] = [property, t.nullLiteral()];
        operationArguments["argument"] = [
          path.node.right,
          getLastOperationTrackingResultCall
        ];
      } else if (path.node.left.type === "Identifier") {
        var right = createSetMemoValue(
          "lastAssignmentExpressionArgument",
          path.node.right,
          getLastOperationTrackingResultCall
        );
        path.node.right = right;

        trackingAssignment = runIfIdentifierExists(
          path.node.left.name + "_t",
          ignoreNode(
            t.assignmentExpression(
              "=",
              ignoredIdentifier(path.node.left.name + "_t"),
              getLastOperationTrackingResultCall
            )
          )
        );
        trackingAssignment.ignore = true;

        operationArguments["currentValue"] = ignoredArrayExpression([
          path.node.left,
          getLastOperationTrackingResultCall
        ]);
        (operationArguments["newValue"] = ignoredArrayExpression([
          path.node,
          getLastOperationTrackingResultCall
        ])),
          (operationArguments["argument"] = ignoredArrayExpression([
            createGetMemoValue("lastAssignmentExpressionArgument"),
            createGetMemoTrackingValue("lastAssignmentExpressionArgument")
          ]));
      } else {
        throw Error("unhandled assignmentexpression node.left type");
      }

      const operation = this.createNode(operationArguments, {
        operator: ignoredStringLiteral(path.node.operator)
      }, path.node.loc);

      if (trackingAssignment) {
        path.replaceWith(
          t.sequenceExpression([operation, trackingAssignment, getLastOpValue])
        );
      } else {
        path.replaceWith(operation);
      }
    }
  }
};

function eachArgumentInObject(args, operationName, fn) {
  const operation = operations[operationName];
  const isObjectExpression = operationName === OperationTypes.objectExpression;

  let arrayArguments = [];
  if (operation && operation.arrayArguments) {
    arrayArguments = operation.arrayArguments;
  }

  if (isObjectExpression) {
    // todo: this is an objexpression property not an obj expression itself, should be clarified
    fn(args.value, "value", newValue => {
      args.value = newValue;
    });
    fn(args.key, "key", newValue => (args.key = newValue));
  } else {
    Object.keys(args).forEach(key => {
      if (arrayArguments.includes(key)) {
        args[key].forEach((a, i) => {
          fn(a, "element" + i, newValue => (args[key][i] = newValue));
        });
      } else {
        fn(args[key], key, newValue => (args[key] = newValue));
      }
    });
  }
}

export function eachArgument(operationLog, fn) {
  eachArgumentInObject(operationLog.args, operationLog.operation, fn);

  if (operationLog.extraArgs) {
    eachArgumentInObject(operationLog.extraArgs, operationLog.operation, fn);
  }
}

Object.keys(operations).forEach(opName => {
  const operation = operations[opName];
  operation.createNode = function (args, astArgs, loc = null) {
    const operation = createOperation(OperationTypes[opName], args, astArgs, loc);
    return operation
  };
  if (!operation.arrayArguments) {
    operation.arrayArguments = [];
  }
  operation.getArgumentsArray = function (operationLog) {
    var ret = [];
    eachArgument(operationLog, (arg, argName, updateValue) => {
      ret.push({ arg: arg, argName });
    });

    return ret;
  };
});

export default operations;