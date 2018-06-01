const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
var moment = require('moment');
const Mailgun = require('mailgun-js');
const mailgun = new Mailgun({ apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN });
const request = require('request-promise');

const { ShipmentsController } = require('../shipments/shipments.controller');
const { ReturnsModel } = require('./returns.model');

exports.ReturnsController = new class ReturnsController {
  constructor() {
    this.Return = new Parse.Object.extend('Return');
  }
  
  deleteReturn(returnId){
    return ReturnsModel.getReturnsByFilters({equal: [{ key: 'objectId', value: returnId }]}).first().then(result =>{
      return result.set('deleted', true).save().then(() => {return returnId;})
    })
  }

  deleteReturnEmail(returnId){
    return ReturnsModel.getReturnsByFilters({equal: [{ key: 'objectId', value: returnId }]}).first().then(result =>{
      return result.set('emailDeleted', true).save().then(() => {return returnId;})
    })
  }

  getReturnsWithInformation() {
    return ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment','shippoReturnData'],
      limit: 1000,
      notEqual: [{key:'deleted', value:true}]
    }).find()
      .then(returnsObjects => returnsObjects.map(returnObject => this.minifyReturnForFrontEnd(returnObject)));
  }

  createOrderProductReturn({ order, orderProduct, customer, product, productVariant, orderShipment, options, returnTypeId }) {
    if ((typeof order === 'undefined' || order === null) 
        || (typeof orderProduct === 'undefined' || orderProduct === null)
        || (typeof customer === 'undefined' || customer === null)
        || (typeof product === 'undefined' || product === null)
        || (typeof productVariant === 'undefined' || productVariant === null)
        || (typeof orderShipment === 'undefined' || orderShipment === null)
        || (typeof options === 'undefined' || options === null)
        || (typeof returnTypeId === 'undefined' || returnTypeId === null)) {
      return Promise.reject('missing parameters');
    }

    const createNewReturn = ({ object_id, rate, tracking_number, tracking_url_provider, label_url, parcel }) => {
      const newReturn = new this.Return();
      return newReturn
        .set('checkedInAt', null)
        .set('orderId', order.get('orderId'))
        .set('order', order)
        .set('orderProductId', orderProduct.get('orderProductId'))
        .set('orderProduct', orderProduct)
        .set('customerId', customer.get('customerId'))
        .set('customer', customer)
        .set('productId', product.get('productId'))
        .set('product', product)
        .set('productVariantId', productVariant.get('variantId'))
        .set('productVariant', productVariant)
        .set('returnStatusId', 0)
        .set('returnStatus', this.returnStatuses(0))
        .set('returnTypeId', returnTypeId)
        .set('returnType', this.returnTypes(returnTypeId))
        .set('returnOptions', options)
        .set('orderShipmentId', orderShipment.get('shipmentId'))
        .set('orderShipment', orderShipment)
        .set('requestReturnEmailSended', false)
        .set('checkedInEmailSended', false)
        .set('shippoReturnData', { object_id, rate, tracking_number, tracking_url_provider, label_url, parcel })
        .save();
    }

    const addReturnToOrderProduct = (returnObject, orderProduct) => {
      const returns = orderProduct.get('returns') ? orderProduct.get('returns') : [];
      return orderProduct.set('returns', [
        ...returns,
        returnObject
      ]).save()
        .then(updatedOrderProduct => ({
          returnObject,
          orderProduct: updatedOrderProduct
        }));
    }
    
    // return createNewReturn({})
    return this.createReturnLabel(order, orderShipment)
      .then(createNewReturn)
      .then(returnObject => addReturnToOrderProduct(returnObject, orderProduct));

  }

  createReturnLabel(order, orderShipment) {
    const shippedWithShippo = orderShipment.has('shippo_object_id');
    const address_to = ShipmentsController.baseAddress;
    const address_from = ShipmentsController.shippoShipmentAddressFromOrder(order);
    const defaultParcel = ShipmentsController.defaultUPSSmallBox;

    return shippo.transaction.create({
      shipment: {
        "object_purpose": "PURCHASE",
        "address_from": { 
          ...address_from,
          object_purpose: "PURCHASE" 
        },
        "address_to": {
          ...address_to,
          object_purpose: "PURCHASE"
        },
        "parcel": defaultParcel,
        // "extra": { "is_return": shippedWithShippo },
        // "return_of": shippedWithShippo ? orderShipment.get('shippo_object_id') : undefined,
      },
      "carrier_account": "c67f85102205443e813814c72f2d48c6",
      "servicelevel_token": "usps_priority",
      "async": false,
    });
  }

  checkInReturnedProduct(returnId) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const isChecked = returnObject => {
      if (returnObject.get('checkedInAt') === null)
        return returnObject;
      else
        throw { success: false, message: 'Return already checked in' };
    }
    
    const setReturnAsCheckedIn = returnObject => {
      const returnTypeId = returnObject.get('returnTypeId');
      let newReturnStatusId;
      switch(returnTypeId) {
        case 1:
          newReturnStatusId = 1;
        break;

        case 2:
          newReturnStatusId = 2;
        break;

        default:
          newReturnStatusId = 5;
        break;
      }
      return returnObject
        .set('checkedInAt', new Date())
        .set('returnStatusId', newReturnStatusId)
        .set('returnStatus', this.returnStatuses(newReturnStatusId))
        .save();
    }

    return returnObject(returnId)
      .then(isChecked)
      .then(setReturnAsCheckedIn)
      .then(this.minifyReturnForFrontEnd);
  }

  updateReturnStatus(returnId, returnStatusId) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const updateReturnStatus = returnObject => {
      return returnObject
        .set('returnStatusId', returnStatusId)
        .set('returnStatus', this.returnStatuses(returnStatusId))
        .save();
    }

    return returnObject(returnId)
      .then(updateReturnStatus)
      .then(this.minifyReturnForFrontEnd);
  }

  returnsForEmails() {
    const toRequestReturns = ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'returnStatusId', value: 0 },
        { key: 'requestReturnEmailSended', value: false },
        { key: 'checkedInEmailSended', value: false },
        { key: 'checkedInAt', value: null }
      ],
      notEqual:[
        {key:'emailDeleted', value: true}
      ]
    });
    
    const checkedInReturnsEmails = ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'checkedInEmailSended', value: false },
      ],
      notEqual: [
        { key: 'returnTypeId', value: 0 },
        { key: 'returnStatusId', value: 0 },
        { key: 'checkedInAt', value: null }
      ]
    })

    return Parse.Query.or(toRequestReturns, checkedInReturnsEmails)
      .include('order')
      .include('orderProduct')
      .include('customer')
      .include('product')
      .include('product.classification')
      .include('productVariant')
      .include('orderShipment')
      .find()
      .then(returnsObjects => returnsObjects.map(ro => this.minifyReturnForFrontEnd(ro)));
  }

  sendReturnEmail(returnId, emailSubject, emailText, emailTo) {
    const returnObject = returnId => ReturnsModel.getReturnsByFilters({
      includes: ['order', 'orderProduct', 'customer', 'product', 'product.classification', 'productVariant', 'orderShipment'],
      equal: [{ key: 'objectId', value: returnId }]
    }).first();

    const updateReturnObject = returnObject => {
      if (returnObject.get('returnStatusId') === 0)
        returnObject.set('requestReturnEmailSended', true);
      else if (returnObject.get('requestReturnEmailSended') && returnObject.get('returnStatusId') !== 0)
        returnObject.set('checkedInEmailSended', true);
      else 
        return Promise.reject(`There is a problem sending the email about the return #${returnObject.id}`)

      return returnObject.save();
    }

    const sendEmail = returnObject => {
      if (typeof returnObject.get('shippoReturnData').label_url === 'undefined')
        return Promise.reject(`This shipment wasn't made with Shippo so is not possible to make the automatic return with it.`);

        return request
        .defaults({ encoding: null })
        .get(returnObject.get('shippoReturnData').label_url)
        .then(label => {
          const attch = new mailgun.Attachment({ 
            data: label, 
            filename: 'label.pdf',
            contentType: 'application/pdf'
          });
          var emailToSend = `${returnObject.get('order').get('customer').get('firstName') + ' ' + returnObject.get('order').get('customer').get('lastName')} <${process.env.NODE_ENV === 'production' ? returnObject.get('order').get('billing_address').email : 'ejas94@gmail.com'}>`;
          (emailTo != undefined && emailTo != '') ? emailToSend = emailTo : emailToSend = emailToSend;
          return {
            from: 'tracy@loveaudryrose.com',
            to: emailToSend,
            cc: process.env.NODE_ENV === 'production' ? 'Audry Rose <tracy@loveaudryrose.com>' : 'Testing <edisonpaul4@gmail.com>',
            subject: emailSubject,
            html: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="ie=edge"><style>a{display:none;}</style><title></title></head><body><p>' + emailText.replace(/\n/g, '<br>') + '</p></body></html >',
            attachment: !returnObject.get('requestReturnEmailSended') ? attch : null
          }
        })
        .then(message => mailgun.messages().send(message)) 
        .then(emailResult => returnObject);
    }

    return returnObject(returnId)
      .then(returnObject => sendEmail(returnObject))
      .then(updateReturnObject)
      .then(this.minifyReturnForFrontEnd);
  }

  /** ------------------------------------------- */
  /** ------------- Extra Functions ------------- */
  /** ------------------------------------------- */

  minifyReturnForFrontEnd(returnObject) {
    const order = returnObject.get('order');
    const product = returnObject.get('product');
    const classification = product.get('classification');
    const customer = returnObject.get('customer');
    return {
      id: returnObject.id,
      dateRequested: moment(returnObject.get('createdAt')).toISOString(),
      dateCheckedIn: returnObject.get('checkedInAt') ? moment(returnObject.get('checkedInAt')).toISOString() : null,
      orderId: returnObject.get('orderId'),
      customerName: customer.get('firstName') + ' ' + customer.get('lastName'),
      customerLifetime: {
        totalSpend: customer.get('totalSpend'),
        totalOrders: customer.get('totalOrders'),
      },
      productName: product.get('name'),
      productImage: product.get('primary_image') ? product.get('primary_image').thumbnail_url : null,
      productClassification: classification ? classification.get('name') : null,
      returnOptions: returnObject.get('returnOptions'),
      orderNotes: {
        staffNotes: order.get('staff_notes') ? order.get('staff_notes') : null,
        internalNotes: order.get('internalNotes') ? order.get('internalNotes') : null,
        designerNotes: order.get('designerNotes') ? order.get('designerNotes') : null,
        customerNotes: order.get('customer_message') ? order.get('customer_message') : null,
      },
      returnStatus: returnObject.get('returnStatus'),
      returnStatusId: returnObject.get('returnStatusId'),
      returnType: returnObject.get('returnType'),
      returnTypeId: returnObject.get('returnTypeId'),
      shippoInfo: returnObject.get('shippoReturnData')
    }
  }

  returnTypes(index) {
    const returnTypes = [
      'return',
      'repair',
      'resize'
    ];
    return typeof index !== 'undefined' ? returnTypes[index] : returnTypes;
  }

  returnStatuses(index) {
    const returnStatuses = [
      'requested',
      'being repaired',
      'being resized',
      'resize completed',
      'repair completed',
      'completed'
    ];
    return typeof index !== 'undefined' ? returnStatuses[index] : returnStatuses;
  }  

}