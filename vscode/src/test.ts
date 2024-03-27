import { MyClass, User, testLSP, testTypeDef } from './jsonrpc/agent-protocol'

const user: User = {
    name: '<NAME>',
    lovesBanana: true,
}

testLSP({
    type: 'edit',
    editResult: '',
})

const instance = new MyClass()
