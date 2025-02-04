import * as path from 'path'
import * as net from 'net'
import { window, workspace, ExtensionContext, Task, tasks, ShellExecution, OutputChannel } from 'vscode'
import * as cp from 'child_process'
import { LanguageClient, LanguageClientOptions, StreamInfo } from 'vscode-languageclient'
import * as semver from 'semver'
import * as execa from 'execa'

let client: LanguageClient
let proc: cp.ChildProcess
let logger: OutputChannel

const versionRequirement = ">=1.8.1"

function getConfigValue( value: string ): any {
	return workspace.getConfiguration().get( value )
}

function createRunTask( title: string ): Task {
	let file = window.activeTextEditor.document.fileName;
	let dir = path.dirname( file )
	return new Task( 
		{ type: "run", task: "runJolie" },
		title,
		"Jolie", 
		new ShellExecution( "jolie " + file + " && echo ''", { cwd : dir } ), 
		[] 
	)
}

async function checkRequiredJolieVersion():Promise<void> {
	try {
		const p = await execa('jolie', ['--version'])
		const stderr = p.stderr
		const result = stderr.match(/Jolie\s+(\d\.\d\.\d).+/)
		if (result.length > 1) {
			const jolieVersion = result[1]
			if( !semver.satisfies(jolieVersion, versionRequirement) ) {
				window.showErrorMessage(`This extension requires Jolie version ${versionRequirement}, whereas your version is ${jolieVersion}. Some features may not work correctly. Please consider updating your Jolie installation.`)
			}
		} else {
			window.showErrorMessage(`Could not detect the version of the Jolie interpreter. Output of \"jolie --version\": ${stderr}`)
		}
	} catch(err) {
		window.showErrorMessage('Could not start the Jolie interpreter. Please check that the jolie executable is installed.')
	}
}

function registerTasks() {
	tasks.registerTaskProvider( "run", {
		provideTasks: () => {
			return [ createRunTask( "Run current Jolie program" ) ];
		},
		resolveTask( task : Task ): Task | undefined {
			return task
		}
	})
}

function log( message: string ) {
	if( getConfigValue( 'jolie.showDebugMessages' ) ){
		logger.appendLine( message )
	}
}

export async function activate(context: ExtensionContext) {
	await checkRequiredJolieVersion()
	registerTasks()
	
	logger = window.createOutputChannel( 'Jolie LSP Client' )
	const serverPort: number = getConfigValue( 'jolie.serverPort' )

	log( "Activating Jolie Language Server" )
	
	const serverOptions = () => new Promise<StreamInfo>( (resolve, reject) => {
		const serverPath = context.asAbsolutePath(path.join('server', 'src'))
		const tcpPort = serverPort
		const command = 'jolie'
		const olFile = 'main.ol'
		const args = ['-C', `Location_JolieLS=\"socket://localhost:${tcpPort}\"`, olFile]
		// const args = ['-C', `Location_JolieLS=\"socket://localhost:${tcpPort}\"`, '-C', 'Debug=true', olFile]
		// const args = ['-C', `Location_JolieLS=\"socket://localhost:${tcpPort}\"`, '--trace', olFile]
		log(`starting "${command} ${args.join(' ')}"`)
		const proc = cp.spawn(command, args, { cwd: serverPath })

		proc.stdout.on('data', (out) => {
			const message = String(out)
			if ( message.includes( "Jolie Language Server started" ) ) {
				//if the jolie process has started, we connect the client to the socket and resolve the childProcess
				const socket = net.createConnection( { port : tcpPort, host:'localhost' } )
				resolve({ reader: socket, writer: socket })
			}
			log(`Jolie says: ${message}`)
		})
		proc.stderr.on('data', (out) => {
			if( String( out ).includes( "service initialisation failed" ) ){
				window.showErrorMessage( String( out ) )
			}
			if( String( out ).includes( "Address already in use" ) ){
				window.showErrorMessage( String( out ) )
				window.showInformationMessage( "Please check that port: " + tcpPort + " of the local machine is free. " + 
				"Alternatively, you can change the port number under the Jolie Language Support extension configuration; " +
				"After the change, remembers to reboot your editor." )
			}
			log( String( out ) )
		})
	})

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'jolie' }, { scheme: 'untitled', language: 'jolie' }],
		synchronize: {
			// configurationSection: 'jolie',
			fileEvents: workspace.createFileSystemWatcher('**/*.{ol,iol}')
		}
	}

	client = new LanguageClient(
		'vscode-jolie',
		'Jolie Language Server',
		serverOptions,
		clientOptions
	)

	client.start()
}

export async function deactivate(): Promise<void> | undefined {
	if ( !client ) {
		return undefined	
	}
	return client.stop().then( function(){
		if( proc ){
			proc.kill( 'SIGINT' )
		}
	})
}