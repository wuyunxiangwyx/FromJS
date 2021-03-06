# Contributing

[Create a new issue](https://github.com/mattzeunert/FromJS/issues) if you find a bug or have a question/feature request.

## Contributing code

I'm working on FromJS 2 right now and the code isn't always very clean. Open an issue or email me if you're interested in contributing anyway.

## Build FromJS

Use `lerna bootstrap` to install dependencies.

I usually run all of these commands:

* `yarn run test-watch` for unit/integration tests
* In packages/ui `yarn run webpack-watch` for building the inspector UI
* In packages/core `yarn run webpack-watch` to build the helperFunctions (compiled result is used by Babel plugin)
* `yarn run compile-all-watch`
* `npm run cli-debug`
* `npm run cli-browser` (open browser separately so the BE/Proxy process can restart)

If you change the welcome page there's a separate bundle for that in @fromjs/backend.

### Env variables

`VERIFY=true` enables sanity check on collected data and points out when tracking data is missing

### Running E2E tests

You need to run the [web server for the test cases](git clone git@github.com:mattzeunert/fromjs-test-cases.git) locally, check the CI config for details.

## Debugging

Add `?debug` to the inspector URL to get a button to enter debug mode. Debug mode for example lets you see the complete log JSON.

## Architecture diagram

![](https://user-images.githubusercontent.com/1303660/41681002-35ebae24-74cb-11e8-8a2d-d2a2b8b34145.png)
